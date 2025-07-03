import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import session from 'express-session';
import dotenv from 'dotenv';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

// Initialize environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = process.env.PORT || 3000;

// AWS Configuration
const REGION = process.env.AWS_REGION || 'us-east-1';
const dynamoClient = new DynamoDBClient({ 
  region: REGION,
  ...(process.env.IS_LOCAL === 'true' && {
    endpoint: 'http://localhost:8000',
    credentials: {
      accessKeyId: 'fakeMyKeyId',
      secretAccessKey: 'fakeSecretAccessKey'
    }
  })
});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const snsClient = new SNSClient({ region: REGION });

// Environment Variables
const PATIENTS_TABLE = process.env.PATIENTS_TABLE || 'PatientsTable';
const DOCTORS_TABLE = process.env.DOCTORS_TABLE || 'DoctorsTable';
const APPOINTMENTS_TABLE = process.env.APPOINTMENTS_TABLE || 'AppointmentsTable';
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN;

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json()); // Add JSON parsing middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false
}));

// Helper functions for DynamoDB
const getUserByEmail = async (email, role) => {
  const tableName = role === 'doctor' ? DOCTORS_TABLE : PATIENTS_TABLE;
  const command = new GetCommand({
    TableName: tableName,
    Key: { email }
  });
  const { Item } = await docClient.send(command);
  return Item;
};

const createUser = async (userData, role) => {
  const tableName = role === 'doctor' ? DOCTORS_TABLE : PATIENTS_TABLE;
  const command = new PutCommand({
    TableName: tableName,
    Item: {
      ...userData,
      role,
      createdAt: new Date().toISOString()
    }
  });
  await docClient.send(command);
};

const getAppointments = async (userId, role) => {
  const key = role === 'doctor' ? 'doctorId' : 'patientId';
  const command = new QueryCommand({
    TableName: APPOINTMENTS_TABLE,
    IndexName: `${key}-index`,
    KeyConditionExpression: `${key} = :userId`,
    ExpressionAttributeValues: {
      ':userId': userId
    }
  });
  const { Items } = await docClient.send(command);
  return Items || [];
};

const createAppointment = async (appointmentData) => {
  const command = new PutCommand({
    TableName: APPOINTMENTS_TABLE,
    Item: {
      ...appointmentData,
      id: Date.now().toString(),
      status: 'Scheduled',
      createdAt: new Date().toISOString()
    }
  });
  await docClient.send(command);
};

const updateAppointment = async (id, updateData) => {
  const updateExpressions = [];
  const expressionAttributeValues = {};
  const expressionAttributeNames = {};

  Object.entries(updateData).forEach(([key, value], index) => {
    updateExpressions.push(`#${key}${index} = :${key}${index}`);
    expressionAttributeValues[`:${key}${index}`] = value;
    expressionAttributeNames[`#${key}${index}`] = key;
  });

  const command = new UpdateCommand({
    TableName: APPOINTMENTS_TABLE,
    Key: { id },
    UpdateExpression: `SET ${updateExpressions.join(', ')}`,
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues,
    ReturnValues: 'ALL_NEW'
  });

  await docClient.send(command);
};

// Auth middleware
const requireDoctor = (req, res, next) => {
  if (req.session.user?.role === 'doctor') return next();
  res.redirect('/');
};

const requirePatient = (req, res, next) => {
  if (req.session.user?.role === 'patient') return next();
  res.redirect('/');
};

// Routes
app.get('/login', (req, res) => res.render('login', { message: null }));

app.get("/", (req, res) => res.render("index"));
app.get("/contactus", (req, res) => res.render("contact"));
app.get("/about", (req, res) => res.render("about"));
app.get("/register", (req, res) => res.render("register"));

app.get("/patient/dashboard", async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  
  const patient = await getUserByEmail(req.session.user.email, 'patient');
  if (!patient) return res.redirect('/logout');

  res.render("dashboard", {
    Name: patient.name,
    Email: patient.email,
    Phone: patient.phone,
    Address: patient.address,
    Age: patient.dob,
    Gender: patient.gender,
  });
});

app.post('/register/patient', async (req, res) => {
  const { firstName, lastName, dob, gender, email, phone, address, password } = req.body;
  
  // Check if patient exists
  const existingPatient = await getUserByEmail(email, 'patient');
  if (existingPatient) return res.send('Patient exists');

  // Create new patient
  await createUser({
    id: Date.now().toString(),
    name: `${firstName} ${lastName}`,
    dob,
    gender,
    email,
    phone,
    address,
    password: await bcrypt.hash(password, 10)
  }, 'patient');

  // Send SNS notification
  if (SNS_TOPIC_ARN) {
    const snsCommand = new PublishCommand({
      TopicArn: SNS_TOPIC_ARN,
      Message: `New patient registered: ${firstName} ${lastName} (${email})`,
      Subject: 'MedTrack Registration'
    });
    await snsClient.send(snsCommand).catch(err => console.error('SNS Error:', err));
  }

  res.redirect('/login');
});

app.post('/register/doctor', async (req, res) => {
  const { firstName, lastName, specialization, license, experience, hospital, email, phone, address, password } = req.body;
  
  // Check if doctor exists
  const existingDoctor = await getUserByEmail(email, 'doctor');
  if (existingDoctor) return res.send('Doctor exists');

  // Create new doctor
  await createUser({
    id: Date.now().toString(),
    name: `${firstName} ${lastName}`,
    specialization,
    license,
    experience,
    hospital,
    email,
    phone,
    address,
    password: await bcrypt.hash(password, 10)
  }, 'doctor');

  // Send SNS notification
  if (SNS_TOPIC_ARN) {
    const snsCommand = new PublishCommand({
      TopicArn: SNS_TOPIC_ARN,
      Message: `New doctor registered: ${firstName} ${lastName} (${email}) - ${specialization}`,
      Subject: 'MedTrack Registration'
    });
    await snsClient.send(snsCommand).catch(err => console.error('SNS Error:', err));
  }

  res.redirect('/login');
});

app.post('/check', async (req, res) => {
  const { email, password, role } = req.body;
  
  const user = await getUserByEmail(email, role);
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.render('login', { message: 'Invalid credentials' });
  }

  req.session.user = { 
    id: user.id, 
    name: user.name, 
    email: user.email,
    role: user.role 
  };
  res.redirect(`/${role}`);
});

// Doctor Dashboard
app.get('/doctor', requireDoctor, async (req, res) => {
  const doctorAppointments = await getAppointments(req.session.user.id, 'doctor');
  const today = new Date().toISOString().split('T')[0];
  
  const stats = {
    todayCount: doctorAppointments.filter(a => a.date === today).length,
    todayConfirmed: doctorAppointments.filter(a => a.date === today && a.status === 'Confirmed').length,
    weekCount: doctorAppointments.length,
    weekDiff: 0,
    patientTotal: (new Set(doctorAppointments.map(a => a.patientId))).size,
    patientNew: doctorAppointments.filter(a => new Date(a.date) >= new Date(today.substring(0,7)+'-01')).length,
    prescriptionTotal: doctorAppointments.filter(a => a.precautions).length,
    prescriptionWeekly: 0
  };

  const patients = doctorAppointments.map(a => ({
    patientName: a.patientName,
    patientId: a.patientId,
    date: a.date,
    time: a.time,
    status: a.status,
    precautions: a.precautions || null,
    reason: a.reason,
    id: a.id
  }));

  res.render('doctor', {
    doctor: req.session.user,
    appointments: doctorAppointments,
    stats, 
    patients
  });
});

// Appointment actions
app.post('/doctor/appointment/:id/precautions', requireDoctor, async (req, res) => {
  await updateAppointment(req.params.id, {
    precautions: req.body.precautions,
    status: 'Completed',
    updatedAt: new Date().toISOString()
  });
  res.redirect('/doctor');
});

app.post('/doctor/appointment/:id/reschedule', requireDoctor, async (req, res) => {
  await updateAppointment(req.params.id, {
    date: req.body.date,
    time: req.body.time,
    status: 'Rescheduled',
    updatedAt: new Date().toISOString()
  });
  res.redirect('/doctor');
});

app.post('/doctor/appointment/:id/cancel', requireDoctor, async (req, res) => {
  await updateAppointment(req.params.id, {
    status: 'Cancelled',
    updatedAt: new Date().toISOString()
  });
  res.redirect('/doctor');
});

// Patient Dashboard
app.get('/patient', requirePatient, async (req, res) => {
  const appointments = await getAppointments(req.session.user.id, 'patient');
  const doctorsCommand = new ScanCommand({
    TableName: DOCTORS_TABLE
  });
  const { Items: doctors } = await docClient.send(doctorsCommand);
  
  res.render('patient', { 
    patient: req.session.user, 
    appointments, 
    prescriptions: appointments.filter(a => a.precautions), 
    doctors: doctors || [] 
  });
});

app.post('/patient/book', requirePatient, async (req, res) => {
  const { doctorId, date, time, reason } = req.body;
  
  // Get doctor info
  const doctorCommand = new GetCommand({
    TableName: DOCTORS_TABLE,
    Key: { id: doctorId }
  });
  const { Item: doctor } = await docClient.send(doctorCommand);
  if (!doctor) return res.send('Invalid doctor');

  // Create appointment
  await createAppointment({
    doctorId,
    doctorName: doctor.name,
    specialty: doctor.specialization,
    patientId: req.session.user.id,
    patientName: req.session.user.name,
    date, 
    time, 
    reason
  });

  res.redirect('/patient');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`Using AWS Region: ${REGION}`);
  console.log(`Patients Table: ${PATIENTS_TABLE}`);
  console.log(`Doctors Table: ${DOCTORS_TABLE}`);
  console.log(`Appointments Table: ${APPOINTMENTS_TABLE}`);
});