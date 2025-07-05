// server.js - SIMPLIFIED: User creation only
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Environment validation with YOUR actual variable names
if (!process.env.PTERODACTYL_API_URL || !process.env.PTERODACTYL_API_KEY) {
  console.error('❌ Missing PTERODACTYL_API_URL or PTERODACTYL_API_KEY');
  process.exit(1);
}

// Build the full API URL - FIXED to match your working server
const PTERODACTYL_BASE = `https://${process.env.PTERODACTYL_API_URL}/api/application`;
const PTERODACTYL_API_KEY = process.env.PTERODACTYL_API_KEY;

console.log('🔧 Environment loaded:');
console.log(`📍 Panel URL: ${process.env.PTERODACTYL_API_URL}`);
console.log(`📍 Full API URL: ${PTERODACTYL_BASE}`);
console.log(`🔑 API Key: ${PTERODACTYL_API_KEY.substring(0, 15)}...`);

// Helper function for Pterodactyl API requests
const pterodactylRequest = async (method, endpoint, data = null) => {
  const config = {
    method,
    url: `${PTERODACTYL_BASE}${endpoint}`,
    headers: {
      'Authorization': `Bearer ${PTERODACTYL_API_KEY}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    timeout: 15000
  };
  
  if (data) {
    config.data = data;
  }
  
  console.log(`📡 ${method} ${config.url}`);
  if (data) {
    console.log(`📤 Request data:`, JSON.stringify(data, null, 2));
  }
  
  try {
    const response = await axios(config);
    console.log(`✅ ${method} ${endpoint} - Status: ${response.status}`);
    return response;
  } catch (error) {
    console.error(`❌ ${method} ${endpoint} - Error:`, {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      message: error.message
    });
    throw error;
  }
};

// Generate secure password
function generateRandomPassword(length = 16) {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  const randomBytes = crypto.randomBytes(length);
  let password = '';
  
  for (let i = 0; i < length; i++) {
    password += charset[randomBytes[i] % charset.length];
  }
  
  return password;
}

// Generate username from email
function generateUsernameFromEmail(email) {
  const baseUsername = email.split('@')[0]
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase()
    .slice(0, 12);
  
  const randomSuffix = Math.floor(Math.random() * 9999).toString().padStart(4, '0');
  return `${baseUsername}${randomSuffix}`;
}

// MAIN FUNCTION: Create User
const CreateUser = async (email) => {
  const timestamp = Date.now();
  console.log(`\n🚀 [${timestamp}] Starting user creation for: ${email}`);
  
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new Error('Invalid email address provided');
  }

  try {
    // STEP 1: Search for existing user
    console.log(`🔍 [${timestamp}] Searching for existing user...`);
    const searchUrl = `/users?filter[email]=${encodeURIComponent(email)}`;
    
    const searchResponse = await pterodactylRequest('GET', searchUrl);
    
    console.log(`📊 [${timestamp}] Search results:`, {
      status: searchResponse.status,
      userCount: searchResponse.data.data.length,
      users: searchResponse.data.data.map(u => ({
        id: u.attributes.id,
        email: u.attributes.email,
        username: u.attributes.username,
        admin: u.attributes.root_admin
      }))
    });
    
    if (searchResponse.data.data.length > 0) {
      const existingUser = searchResponse.data.data[0].attributes;
      console.log(`✅ [${timestamp}] Found existing user:`, {
        id: existingUser.id,
        username: existingUser.username,
        email: existingUser.email,
        admin: existingUser.root_admin
      });
      
      return {
        success: true,
        userId: existingUser.id,
        username: existingUser.username,
        email: existingUser.email,
        existing: true,
        admin: existingUser.root_admin
      };
    }
    
    // STEP 2: Create new user
    console.log(`🆕 [${timestamp}] Creating new user...`);
    
    const username = generateUsernameFromEmail(email);
    const password = generateRandomPassword(16);
    
    const userData = {
      email: email,
      username: username,
      first_name: username.charAt(0).toUpperCase() + username.slice(1),
      last_name: "User",
      password: password,
      root_admin: false,
      language: "en"
    };
    
    console.log(`📝 [${timestamp}] User data to create:`, {
      ...userData,
      password: '[HIDDEN]'
    });
    
    const createResponse = await pterodactylRequest('POST', '/users', userData);
    
    const createdUser = createResponse.data.attributes;
    console.log(`✅ [${timestamp}] User created successfully:`, {
      id: createdUser.id,
      username: createdUser.username,
      email: createdUser.email,
      admin: createdUser.root_admin
    });
    
    return {
      success: true,
      userId: createdUser.id,
      username: createdUser.username,
      email: createdUser.email,
      password: password,
      existing: false,
      admin: createdUser.root_admin
    };
    
  } catch (error) {
    console.error(`❌ [${timestamp}] User creation failed:`, {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    
    if (error.response?.data?.errors) {
      console.error(`📋 [${timestamp}] Validation errors:`, error.response.data.errors);
    }
    
    throw new Error(`Failed to create/find user: ${error.message}`);
  }
};

// === ROUTES ===

// Debug environment variables
app.get('/debug/env', (req, res) => {
  const env = {
    PTERODACTYL_API_URL: process.env.PTERODACTYL_API_URL,
    PTERODACTYL_API_KEY: process.env.PTERODACTYL_API_KEY ? `${process.env.PTERODACTYL_API_KEY.substring(0, 15)}...` : 'NOT SET',
    FULL_API_URL: `https://${process.env.PTERODACTYL_API_URL}/api/application`,
    NODE_ENV: process.env.NODE_ENV || 'not set'
  };
  
  res.json({
    environment: env,
    status: 'Using your actual environment variable names'
  });
});

// Test user creation
app.post('/create-user', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    console.log(`\n🎯 API Request: Create user for ${email}`);
    
    const result = await CreateUser(email);
    
    console.log(`🎉 API Response: User creation result:`, result);
    
    res.json({
      success: true,
      message: result.existing ? 'User found' : 'User created',
      user: {
        id: result.userId,
        username: result.username,
        email: result.email,
        existing: result.existing,
        admin: result.admin
      },
      credentials: result.existing ? null : {
        username: result.username,
        password: result.password
      }
    });
    
  } catch (error) {
    console.error('❌ API Error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// List all users
app.get('/users', async (req, res) => {
  try {
    console.log('\n📋 API Request: List all users');
    
    const response = await pterodactylRequest('GET', '/users');
    const users = response.data.data.map(user => ({
      id: user.attributes.id,
      email: user.attributes.email,
      username: user.attributes.username,
      admin: user.attributes.root_admin,
      created_at: user.attributes.created_at
    }));
    
    console.log(`📊 Found ${users.length} users`);
    
    res.json({
      success: true,
      count: users.length,
      users: users
    });
  } catch (error) {
    console.error('❌ Failed to list users:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Search user by email
app.post('/search-user', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    console.log(`\n🔍 API Request: Search for user with email: ${email}`);
    
    const searchUrl = `/users?filter[email]=${encodeURIComponent(email)}`;
    const response = await pterodactylRequest('GET', searchUrl);
    
    const users = response.data.data.map(user => ({
      id: user.attributes.id,
      email: user.attributes.email,
      username: user.attributes.username,
      admin: user.attributes.root_admin
    }));
    
    console.log(`📊 Search results: ${users.length} users found`);
    
    res.json({
      success: true,
      searchEmail: email,
      count: users.length,
      users: users
    });
  } catch (error) {
    console.error('❌ User search failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Test API connectivity
app.get('/test-api', async (req, res) => {
  try {
    console.log('\n🧪 API Request: Test Pterodactyl connectivity');
    
    const response = await pterodactylRequest('GET', '/');
    
    res.json({
      success: true,
      message: 'API is working',
      status: response.status
    });
  } catch (error) {
    console.error('❌ API test failed:', error.message);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      details: error.response?.data 
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'user-creation-only'
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 User Creation Server running on port ${PORT}`);
  console.log('📍 Available endpoints:');
  console.log('  GET  /debug/env - Check environment variables');
  console.log('  POST /create-user - Create a new user');
  console.log('  GET  /users - List all users');
  console.log('  POST /search-user - Search user by email');
  console.log('  GET  /test-api - Test API connectivity');
  console.log('  GET  /health - Health check');
  console.log('\n🧪 Test with:');
  console.log(`  curl -X POST http://localhost:${PORT}/create-user -H "Content-Type: application/json" -d '{"email":"test@example.com"}'`);
});

module.exports = { app, CreateUser };
