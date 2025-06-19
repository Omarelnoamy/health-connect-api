const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Pool } = require("pg");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const router = express.Router();
const os = require("os");

const app = express();
const port = process.env.PORT || 3000;

/// 🛠 Ensure both upload folders exist
const clinicalDocsDir = path.join(__dirname, "uploads", "clinicaldocs");
const profilePhotosDir = path.join(__dirname, "uploads", "profilephotos");
fs.mkdirSync(clinicalDocsDir, { recursive: true });
fs.mkdirSync(profilePhotosDir, { recursive: true });

// 🎯 File filter: Only allow valid image types
const fileFilter = (req, file, cb) => {
  const allowedTypes = ["image/jpeg", "image/png", "image/jpg", "image/webp"];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Invalid file type. Only images are allowed."), false);
  }
};

// 📁 Multer storage for clinical documents
const clinicalDocsStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, clinicalDocsDir); // uploads/clinicaldocs
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});
const uploadClinicalDoc = multer({ storage: clinicalDocsStorage });

// 📸 Multer storage for profile photos
const profilePhotoStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, profilePhotosDir); // uploads/profilephotos
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const filename = `patient_${req.params.id}_${Date.now()}${ext}`;
    cb(null, filename);
  },
});
const uploadProfilePhoto = multer({
  storage: profilePhotoStorage,
  fileFilter,
});

function getLanIp() {
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets).flat()) {
    if (iface.family === "IPv4" && !iface.internal) return iface.address;
  }
  return "localhost";
}
app.get("/server-info", (req, res) => {
  res.json({
    host: getLanIp(), // e.g. "10.0.113.116"
    apiPort: 3001,
    appPort: 3000,
  });
});
// ✅ Enable CORS
const allowedOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://10.0.113.116:3000",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type"],
  })
);

// ✅ Body parser for JSON
app.use(bodyParser.json());

// ✅ PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Required for Neon SSL
  },
});


app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// This line serves files in /clinicaldocs at http://localhost:3000/uploads/filename.jpg
app.use(
  "/clinicaldocs",
  express.static(path.join(__dirname, "uploads", "clinicaldocs"))
);

app.use(
  "/profilephotos",
  express.static(path.join(__dirname, "uploads", "profilephotos"))
);

// Create new patient with profile photo upload
app.post(
  "/patients",
  uploadProfilePhoto.single("profile_photo"),
  async (req, res) => {
    const {
      full_name,
      birth_date,
      gender,
      national_id,
      nationality,
      language_spoken,
      blood_type,
    } = req.body;

    const profile_photo_path = req.file
      ? `/uploads/profilephotos/${req.file.filename}`
      : null;

    try {
      const result = await pool.query(
        `INSERT INTO patients (
        full_name, birth_date, gender, national_id, 
        nationality, language_spoken, blood_type, profile_photo_path
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
        [
          full_name,
          birth_date,
          gender,
          national_id,
          nationality,
          language_spoken,
          blood_type,
          profile_photo_path,
        ]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error("Error inserting patient:", err);
      res.status(500).json({ error: "Failed to add patient" });
    }
  }
);

app.post(
  "/patients/:id/photo",
  uploadProfilePhoto.single("photo"),
  async (req, res) => {
    const patientId = req.params.id;
    const relativePath = `/uploads/profilephotos/${req.file.filename}`;

    try {
      await pool.query(
        "UPDATE patients SET profile_photo_path = $1 WHERE patient_id = $2",
        [relativePath, patientId]
      );
      res.json({ success: true, profile_photo_path: relativePath });
    } catch (error) {
      console.error("Error updating DB with profile photo path:", error);
      res.status(500).json({ error: "Failed to update profile photo" });
    }
  }
);

// Get all patients
app.get("/patients", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM patients");
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching patients:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Get single patient by ID
app.get("/patients/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      "SELECT * FROM patients WHERE patient_id = $1",
      [id]
    );
    if (result.rows.length === 0) {
      return res.json({}); // Return empty object instead of 404
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching patient info:", error);
    res.status(500).json({ error: "Failed to fetch patient info" });
  }
});

// Get full patient profile
app.get("/patients/:id/full", async (req, res) => {
  const { id } = req.params;

  try {
    const patientQuery = await pool.query(
      "SELECT * FROM patients WHERE patient_id = $1",
      [id]
    );

    if (patientQuery.rows.length === 0) {
      return res.status(404).json({ error: "Patient not found" });
    }

    const patient = patientQuery.rows[0];

    const [contactInfo, clinicalDocs, medicalHistory, visits, vitals] =
      await Promise.all([
        pool.query("SELECT * FROM contact_info WHERE patient_id = $1", [id]),
        pool.query("SELECT * FROM clinical_documents WHERE patient_id = $1", [
          id,
        ]),
        pool.query("SELECT * FROM medical_history WHERE patient_id = $1", [id]),
        pool.query(
          "SELECT * FROM visits WHERE patient_id = $1 ORDER BY visit_date DESC",
          [id]
        ),
        pool.query(
          "SELECT * FROM vitals WHERE patient_id = $1 ORDER BY recorded_at DESC",
          [id]
        ),
      ]);
    const latestVitals = vitals.rows[0] || null;

    res.json({
      patient,
      contact_info: contactInfo.rows[0] || null,
      clinical_documents: clinicalDocs.rows,
      medical_history: medicalHistory.rows,
      visits: visits.rows,
      vitals: latestVitals,
    });
  } catch (err) {
    console.error("Error fetching full patient profile:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Get latest vitals for a patient
app.get("/patients/:id/vitals", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      "SELECT * FROM vitals WHERE patient_id = $1 ORDER BY recorded_at DESC LIMIT 1",
      [id]
    );
    if (result.rows.length === 0) {
      return res.json({}); // empty object
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error fetching vitals:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Insert new vitals for a patient
app.put("/patients/:id/vitals", async (req, res) => {
  const { id } = req.params;
  const {
    temperature,
    blood_pressure,
    heart_rate,
    height_cm,
    weight_kg,
    notes,
  } = req.body;

  const recorded_at = new Date();

  try {
    const result = await pool.query(
      `INSERT INTO vitals (
        patient_id, temperature, blood_pressure, heart_rate, 
        height_cm, weight_kg, notes, recorded_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        id,
        temperature,
        blood_pressure,
        heart_rate,
        height_cm,
        weight_kg,
        notes,
        recorded_at,
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error saving vitals:", err);
    res.status(500).json({ error: "Failed to save vitals" });
  }
});

app.get("/patients/:id/medical_history", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      "SELECT * FROM medical_history WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 1",
      [id]
    );
    if (result.rows.length === 0) {
      return res.json({});
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching medical_history:", error);
    res.status(500).json({ error: "Failed to fetch medical_history" });
  }
});

// Insert new medical history for a patient
app.put("/patients/:id/medical_history", async (req, res) => {
  const { id } = req.params;
  const {
    allergies,
    current_medications,
    past_medical_history,
    surgical_history,
    family_history,
    immunization_records,
    chronic_conditions,
    mental_health_conditions,
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO medical_history 
      (patient_id, allergies, current_medications, past_medical_history, surgical_history, family_history, immunization_records, chronic_conditions, mental_health_conditions) 
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *`,
      [
        id,
        allergies,
        current_medications,
        past_medical_history,
        surgical_history,
        family_history,
        immunization_records,
        chronic_conditions,
        mental_health_conditions,
      ]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error inserting medical history:", error);
    res.status(500).json({ error: "Failed to insert medical history" });
  }
});

app.get("/patients/:id/clinical_documents", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      "SELECT * FROM clinical_documents WHERE patient_id = $1 ORDER BY upload_date DESC",
      [id]
    );
    // return an array, even if empty
    return res.json(result.rows);
  } catch (error) {
    console.error("Error fetching clinical_documents:", error);
    res.status(500).json({ error: "Failed to fetch clinical_documents" });
  }
});

// POST /patients/:id/clinical-documents
app.post(
  "/patients/:id/clinical_documents",
  uploadClinicalDoc.single("file"),
  async (req, res) => {
    const { id } = req.params;
    const { document_name } = req.body;
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    const filePath = path
      .join("uploads/clinicaldocs", file.filename)
      .replace(/\\/g, "/");
    const newDoc = {
      patient_id: id,
      document_name,
      upload_date: new Date(),
      file_type: file.mimetype,
      file_path: filePath,
    };

    try {
      const result = await pool.query(
        `INSERT INTO clinical_documents 
         (patient_id, document_name, upload_date, file_type, file_path) 
         VALUES ($1, $2, $3, $4, $5) 
         RETURNING *`,
        [
          newDoc.patient_id,
          newDoc.document_name,
          newDoc.upload_date,
          newDoc.file_type,
          newDoc.file_path,
        ]
      );
      res.status(201).json(result.rows[0]); // Return the inserted document
    } catch (err) {
      console.error("Database error inserting clinical document:", err);
      res.status(500).json({ error: "Database error inserting document" });
    }
  }
);

app.get("/patients/:id/contact_info", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      "SELECT * FROM contact_info WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 1",
      [id]
    );
    if (result.rows.length === 0) {
      return res.json({}); // empty object
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching contact info:", error);
    res.status(500).json({ error: "Failed to fetch contact info" });
  }
});

app.put("/patients/:id/contact_info", async (req, res) => {
  const { id } = req.params;
  const {
    phone,
    email,
    address,
    emergency_name,
    emergency_relation,
    emergency_phone,
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO contact_info 
        (patient_id, phone, email, address, emergency_name, emergency_relation, emergency_phone)
       VALUES 
        ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        id,
        phone,
        email,
        address,
        emergency_name,
        emergency_relation,
        emergency_phone,
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error saving contact info:", error);
    res.status(500).json({ error: "Failed to save contact info" });
  }
});

// Get all visit history for a patient
app.get("/patients/:id/visits", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      "SELECT * FROM visits WHERE patient_id = $1 ORDER BY visit_date DESC",
      [id]
    );
    return res.json(result.rows); // array (possibly empty)
  } catch (error) {
    console.error("Error fetching visits:", error);
    res.status(500).json({ error: "Failed to fetch visits" });
  }
});

// Insert new visit history for a patient
app.put("/patients/:id/visits", async (req, res) => {
  const { id } = req.params;
  const { visit_date, doctor_name, reason, diagnosis, treatment } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO visits 
      (patient_id, visit_date, doctor_name, reason, diagnosis, treatment)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [id, visit_date, doctor_name, reason, diagnosis, treatment]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error inserting visit history:", error);
    res.status(500).json({ error: "Failed to insert visit history" });
  }
});

// Start the server
app.listen(port, () => console.log(`API running on port ${port}`));
