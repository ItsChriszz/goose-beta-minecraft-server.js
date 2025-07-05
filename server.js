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

// Environment validation
if (!process.env.PTERODACTYL_API_URL || !process.env.PTERODACTYL_API_KEY) {
  console.error('❌ Missing PTERODACTYL_API_URL or PTERODACTYL_API_KEY');
  process.exit(1);
}

console.log('🔧 Environment loaded:');
console.log(`📍 Panel URL: ${process.env.PTERODACTYL_API_URL}`);
console.log(`🔑 API Key: ${process.env.PTERODACTYL_API_KEY.substring(0, 15)}...`);

// Helper function for Pterodactyl API requests
const pterodactylRequest = async (method, endpoint, data = null) => {
  const config = {
    method,
    url: `${process.env.PTERODACTYL_API_URL}${endpoint}`,
    headers: {
      'Authorization': `Bearer ${process.env.PTERODACTYL_API_KEY}`,
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

// Improved username generator
function generateUsernameFromEmail(email) {
  let username = email.split('@')[0]
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .slice(0, 10); // Keep it short for suffix

  // Add random suffix if too short
  if (username.length < 4) {
    username += 'user';
  }

  // Add random number suffix
  const suffix = Math.floor(Math.random() * 9000 + 1000);
  return `${username}${suffix}`.slice(0, 16); // Ensure max length of 16
}

// Secure password generator
function generateRandomPassword(length = 16) {
  const chars = {
    lower: 'abcdefghijklmnopqrstuvwxyz',
    upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    numbers: '0123456789',
    symbols: '!@#$%^&*'
  };
  const allChars = Object.values(chars).join('');

  let password = '';
  password += chars.lower[crypto.randomInt(0, chars.lower.length)];
  password += chars.upper[crypto.randomInt(0, chars.upper.length)];
  password += chars.numbers[crypto.randomInt(0, chars.numbers.length)];
  password += chars.symbols[crypto.randomInt(0, chars.symbols.length)];

  for (let i = password.length; i < length; i++) {
    password += allChars[crypto.randomInt(0, allChars.length)];
  }

  return password.split('').sort(() => 0.5 - Math.random()).join('');
}

// MAIN FUNCTION: Create User
const CreateUser = async (email) => {
  // Validate and normalize email
  if (!email || typeof email !== 'string') {
    throw new Error('Email must be a valid string');
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    throw new Error('Invalid email format');
  }
  email = email.trim().toLowerCase();

  try {
    console.log(`Starting user creation for: ${email}`);

    // 1. Check for existing user
    const searchUrl = `${process.env.PTERODACTYL_API_URL}/users?filter[email]=${encodeURIComponent(email)}`;
    console.log(`Checking existing user at: ${searchUrl}`);
    
    const searchResponse = await axios.get(searchUrl, {
      headers: {
        'Authorization': `Bearer ${process.env.PTERODACTYL_API_KEY}`,
        'Accept': 'application/json'
      },
      timeout: 5000
    });

    if (searchResponse.data.data.length > 0) {
      const user = searchResponse.data.data[0].attributes;
      console.log(`User exists: ${user.username}`);
      return {
        success: true,
        userId: user.id.toString(),
        username: user.username,
        email: user.email,
        existing: true,
        admin: user.root_admin
      };
    }

    // 2. Generate username and password
    const username = generateUsernameFromEmail(email);
    const password = generateRandomPassword(16);
    console.log(`Generated credentials - Username: ${username}, Password: ${password.replace(/./g, '*')}`);

    // 3. Create new user
    const createUrl = `${process.env.PTERODACTYL_API_URL}/users`;
    const userData = {
      email: email,
      username: username,
      first_name: username.split('.')[0] || username,
      last_name: 'User',
      password: password,
      root_admin: false,
      language: 'en'
    };

    console.log(`Creating user at: ${createUrl}`);
    const createResponse = await axios.post(createUrl, userData, {
      headers: {
        'Authorization': `Bearer ${process.env.PTERODACTYL_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    if (!createResponse.data?.attributes) {
      throw new Error('Invalid API response format');
    }

    console.log(`User created successfully: ${createResponse.data.attributes.username}`);
    return {
      success: true,
      userId: createResponse.data.attributes.id.toString(),
      username: createResponse.data.attributes.username,
      email: createResponse.data.attributes.email,
      password: password,
      existing: false,
      admin: createResponse.data.attributes.root_admin
    };

  } catch (error) {
    console.error('User creation failed:', {
      error: error.message,
      status: error.response?.status,
      data: error.response?.data,
      url: error.config?.url
    });

    // Handle specific error cases
    if (error.response?.status === 404) {
      throw new Error(`API endpoint not found (404) - check your PTERODACTYL_API_URL (currently: ${process.env.PTERODACTYL_API_URL})`);
    }
    
    if (error.response?.status === 422) {
      const errors = error.response.data?.errors || [];
      if (errors.some(e => e.detail?.includes('already exists'))) {
        // If user exists due to race condition, try fetching again
        try {
          const retryResponse = await axios.get(
            `${process.env.PTERODACTYL_API_URL}/users?filter[email]=${encodeURIComponent(email)}`,
            {
              headers: {
                'Authorization': `Bearer ${process.env.PTERODACTYL_API_KEY}`,
                'Accept': 'application/json'
              }
            }
          );
          
          if (retryResponse.data.data.length > 0) {
            const user = retryResponse.data.data[0].attributes;
            return {
              success: true,
              userId: user.id.toString(),
              username: user.username,
              email: user.email,
              existing: true,
              admin: user.root_admin
            };
          }
        } catch (retryError) {
          console.error('Retry failed:', retryError.message);
        }
      }
      throw new Error(`Validation error: ${errors.map(e => e.detail).join(', ')}`);
    }

    if (error.response?.status === 403) {
      throw new Error('API authentication failed - check your API key permissions');
    }

    throw new Error(`User creation failed: ${error.message}`);
  }
};

// === ROUTES ===

// Debug environment variables
app.get('/debug/env', (req, res) => {
  const env = {
    PTERODACTYL_API_URL: process.env.PTERODACTYL_API_URL,
    PTERODACTYL_API_KEY: process.env.PTERODACTYL_API_KEY ? `${process.env.PTERODACTYL_API_KEY.substring(0, 15)}...` : 'NOT SET',
    NODE_ENV: process.env.NODE_ENV || 'not set'
  };
  
  res.json({
    environment: env,
    status: 'Using PTERODACTYL_API_URL variable'
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
