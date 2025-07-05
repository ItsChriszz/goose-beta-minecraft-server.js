// server.js - Combined User Creation + Server Management
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS
app.use((req, res, next) => {
  const allowedOrigins = [
    'https://beta.goosehosting.com',
    'https://goosehosting.com',
    'http://localhost:3000', // For development
    'http://localhost:5173'  // For Vite dev
  ];
  
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Environment validation
const validateEnvVars = () => {
  const requiredVars = [
    'PTERODACTYL_API_URL',
    'PTERODACTYL_API_KEY'
  ];
  
  const optionalVars = [
    'STRIPE_SECRET_KEY',
    'MaxServersPerNode',
    'PTERODACTYL_NODE_ID',
    'PTERODACTYL_EGG_ID'
  ];
  
  const missingRequired = requiredVars.filter(varName => !process.env[varName]);
  if (missingRequired.length > 0) {
    console.error('❌ Missing required environment variables:', missingRequired.join(', '));
    process.exit(1);
  }
  
  const missingOptional = optionalVars.filter(varName => !process.env[varName]);
  if (missingOptional.length > 0) {
    console.warn('⚠️ Missing optional environment variables (server creation disabled):', missingOptional.join(', '));
  }
};

validateEnvVars();

console.log('🔧 Environment loaded:');
console.log(`📍 Panel URL: ${process.env.PTERODACTYL_API_URL}`);
console.log(`🔑 API Key: ${process.env.PTERODACTYL_API_KEY.substring(0, 15)}...`);
console.log(`💳 Stripe: ${process.env.STRIPE_SECRET_KEY ? '✅ Configured' : '❌ Not configured'}`);

// Pterodactyl configuration
const PTERODACTYL_BASE = process.env.PTERODACTYL_API_URL;
const PTERODACTYL_API_KEY = process.env.PTERODACTYL_API_KEY;
const MaxServersPerNode = parseInt(process.env.MaxServersPerNode) || 50;
const nodeId = process.env.PTERODACTYL_NODE_ID;

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

// MAIN FUNCTION: Create User (Updated from working version)
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
    const searchUrl = `${PTERODACTYL_BASE}/users?filter[email]=${encodeURIComponent(email)}`;
    console.log(`Checking existing user at: ${searchUrl}`);
    
    const searchResponse = await axios.get(searchUrl, {
      headers: {
        'Authorization': `Bearer ${PTERODACTYL_API_KEY}`,
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
    const createUrl = `${PTERODACTYL_BASE}/users`;
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
        'Authorization': `Bearer ${PTERODACTYL_API_KEY}`,
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
      throw new Error(`API endpoint not found (404) - check your PTERODACTYL_API_URL (currently: ${PTERODACTYL_BASE})`);
    }
    
    if (error.response?.status === 422) {
      const errors = error.response.data?.errors || [];
      if (errors.some(e => e.detail?.includes('already exists'))) {
        // If user exists due to race condition, try fetching again
        try {
          const retryResponse = await axios.get(
            `${PTERODACTYL_BASE}/users?filter[email]=${encodeURIComponent(email)}`,
            {
              headers: {
                'Authorization': `Bearer ${PTERODACTYL_API_KEY}`,
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

// Assign User to Server function
const AssignUserToServer = async (serverId, userId, email) => {
  if (!serverId || !email) {
    throw new Error('serverId and email are required');
  }

  try {
    console.log(`🔗 Assigning user to server ${serverId}`);
    
    const response = await pterodactylRequest('POST', `/servers/${serverId}/users`, {
      email: email,
      permissions: [
        "control.console",
        "control.start",
        "control.stop",
        "control.restart",
        "file.create",
        "file.read",
        "file.update",
        "file.delete",
        "file.archive",
        "file.sftp"
      ]
    });
    
    console.log("✅ User assigned to server successfully");
    return { success: true, data: response.data };
    
  } catch (error) {
    console.error("❌ Assignment error:", {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status
    });
    
    // Handle case where user is already assigned
    if (error.response?.status === 422 && 
        error.response?.data?.errors?.[0]?.detail?.includes('already assigned')) {
      return { success: true, message: 'User already assigned to server' };
    }
    
    throw new Error(`Failed to assign user to server: ${error.message}`);
  }
};

// Server limit checking middleware
const checkServerLimits = async (req, res, next) => {
  if (!nodeId) {
    console.warn('⚠️ Node ID not configured, skipping server limit check');
    return next();
  }

  try {
    console.log(`🔄 Checking server limits on node ${nodeId}`);
    
    const response = await pterodactylRequest('GET', `/nodes/${nodeId}/servers`);
    
    const currentServers = response.data.data.length;
    console.log(`📊 Current servers: ${currentServers}/${MaxServersPerNode}`);
    
    if (currentServers >= MaxServersPerNode) {
      console.error(`🚨 Server limit reached (${currentServers}/${MaxServersPerNode})`);
      return res.status(429).json({ 
        error: 'Server limit reached',
        current: currentServers,
        max: MaxServersPerNode
      });
    }
    
    next();
  } catch (err) {
    console.error('❌ Server limit check failed:', err.message);
    return res.status(500).json({ 
      error: 'Internal server error during limit validation',
      details: err.message
    });
  }
};

// Create Pterodactyl Server function
async function createPterodactylServer(session) {
  if (!process.env.STRIPE_SECRET_KEY || !nodeId || !process.env.PTERODACTYL_EGG_ID) {
    throw new Error('Server creation requires STRIPE_SECRET_KEY, PTERODACTYL_NODE_ID, and PTERODACTYL_EGG_ID');
  }

  try {
    console.log('🚀 Starting server creation process');
    
    // Validate session
    if (!session || typeof session !== 'object') {
      throw new Error('Invalid session data');
    }
    
    // Get customer email with proper validation
    const customerEmail = session.customer_details?.email || 
                        session.customer_email || 
                        session.metadata?.customerEmail ||
                        session.customer?.email;
    
    if (!customerEmail || !customerEmail.includes('@')) {
      throw new Error('Valid customer email is required');
    }
    
    console.log('📧 Using customer email:', customerEmail);
    
    // STEP 1: Create or find user
    const userResult = await CreateUser(customerEmail);
    console.log('👤 User result:', {
      id: userResult.userId,
      username: userResult.username,
      existing: userResult.existing
    });
    
    // STEP 2: Extract server settings from session metadata
    const serverName = session.metadata?.serverName || `Server-${Date.now()}`;
    const totalRam = parseInt(session.metadata?.totalRam) || 4;
    
    // STEP 3: Get available allocation
    const allocRes = await pterodactylRequest('GET', `/nodes/${nodeId}/allocations`);
    
    const allocation = allocRes.data.data.find(a => !a.attributes.assigned);
    if (!allocation) throw new Error('No available server ports');
    
    // STEP 4: Create server
    const serverData = {
      name: serverName,
      user: parseInt(userResult.userId), // This makes the user the owner
      egg: parseInt(process.env.PTERODACTYL_EGG_ID),
      docker_image: 'ghcr.io/pterodactyl/yolks:java_17',
      startup: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}',
      environment: {
        SERVER_JARFILE: 'server.jar',
        SERVER_MEMORY: totalRam * 1024,
        MAX_PLAYERS: 20,
        EULA: 'true'
      },
      limits: {
        memory: totalRam * 1024,
        swap: 0,
        disk: totalRam * 1000,
        io: 500,
        cpu: 0
      },
      feature_limits: {
        databases: 1,
        allocations: 1,
        backups: 3
      },
      allocation: {
        default: allocation.attributes.id
      }
    };
    
    console.log('🛠️ Creating server with config:', JSON.stringify(serverData, null, 2));
    
    const response = await pterodactylRequest('POST', '/servers', serverData);
    
    const serverId = response.data.attributes.id;
    const serverUuid = response.data.attributes.uuid;
    const serverAddress = `mc.example.com:${allocation.attributes.port}`;
    
    console.log('🎉 Server created successfully:', {
      id: serverId,
      uuid: serverUuid,
      address: serverAddress,
      owner: userResult.userId
    });
    
    // STEP 5: Update Stripe session with server details
    if (session.id && process.env.STRIPE_SECRET_KEY) {
      await stripe.checkout.sessions.update(session.id, {
        metadata: {
          ...session.metadata,
          serverId: serverId,
          serverUuid: serverUuid,
          serverAddress: serverAddress,
          pterodactylUserId: userResult.userId,
          ownerEmail: customerEmail,
          createdAt: new Date().toISOString()
        }
      });
    }
    
    return {
      success: true,
      serverId,
      serverUuid,
      serverAddress,
      user: {
        id: userResult.userId,
        email: customerEmail,
        username: userResult.username
      }
    };
    
  } catch (err) {
    console.error('❌ Server creation failed:', {
      message: err.message,
      stack: err.stack,
      response: err.response?.data
    });
    
    throw err;
  }
}

// === ROUTES ===

// Debug environment variables
app.get('/debug/env', (req, res) => {
  const env = {
    PTERODACTYL_API_URL: process.env.PTERODACTYL_API_URL,
    PTERODACTYL_API_KEY: process.env.PTERODACTYL_API_KEY ? `${process.env.PTERODACTYL_API_KEY.substring(0, 15)}...` : 'NOT SET',
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ? 'CONFIGURED' : 'NOT SET',
    PTERODACTYL_NODE_ID: process.env.PTERODACTYL_NODE_ID || 'NOT SET',
    PTERODACTYL_EGG_ID: process.env.PTERODACTYL_EGG_ID || 'NOT SET',
    MaxServersPerNode: MaxServersPerNode,
    NODE_ENV: process.env.NODE_ENV || 'not set'
  };
  
  res.json({
    environment: env,
    status: 'Combined user creation + server management service'
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

// Create Stripe checkout session
app.post('/create-checkout-session', async (req, res) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(500).json({ error: 'Stripe not configured' });
    }

    console.log('📥 Received request body:', JSON.stringify(req.body, null, 2));

    // Handle nested serverConfig structure
    const serverConfig = req.body.serverConfig || req.body;
    const planId = req.body.planId || req.body.plan;

    const { 
      serverName, 
      serverType, 
      minecraftVersion, 
      totalRam, 
      maxPlayers, 
      viewDistance, 
      whitelist, 
      pvp, 
      plugins,
      totalCost 
    } = serverConfig;

    const plan = planId;

    // Validate required fields
    if (!serverName || !plan || !totalCost) {
      return res.status(400).json({ 
        error: 'Missing required fields: serverName, plan, and totalCost are required',
        received: { serverName, plan, totalCost }
      });
    }

    console.log('\n💳 Creating Stripe checkout session:', {
      serverName,
      plan,
      totalCost,
      serverType,
      minecraftVersion
    });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${serverName} - ${plan.toUpperCase()} Plan`,
            description: `Minecraft Server (${serverType} ${minecraftVersion})`
          },
          recurring: {
            interval: 'month'
          },
          unit_amount: Math.round(parseFloat(totalCost || 9.99) * 100) // Convert to cents, default to 9.99
        },
        quantity: 1
      }],
      mode: 'subscription',
      success_url: `https://beta.goosehosting.com/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://beta.goosehosting.com/cancel`,
      metadata: {
        serverName: serverName || 'Unnamed Server',
        plan: plan || 'custom',
        serverType: serverType || 'vanilla',
        minecraftVersion: minecraftVersion || '1.20',
        totalRam: (totalRam || 4).toString(),
        maxPlayers: (maxPlayers || 20).toString(),
        viewDistance: (viewDistance || 10).toString(),
        whitelist: (whitelist || false).toString(),
        pvp: (pvp !== false).toString(), // Default to true
        plugins: Array.isArray(plugins) ? plugins.join(',') : (plugins || 'none')
      }
    });

    console.log('✅ Stripe session created:', session.id);

    res.json({
      success: true,
      sessionId: session.id,
      url: session.url
    });

  } catch (error) {
    console.error('❌ Stripe checkout error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Create server endpoint
app.post('/create-server', checkServerLimits, async (req, res) => {
  try {
    const { sessionData } = req.body;
    
    if (!sessionData) {
      return res.status(400).json({ error: 'Session data is required' });
    }
    
    console.log(`\n🎯 API Request: Create server for session`);
    
    const result = await createPterodactylServer(sessionData);
    
    console.log(`🎉 API Response: Server creation result:`, result);
    
    res.json({
      success: true,
      message: 'Server created successfully',
      server: {
        id: result.serverId,
        uuid: result.serverUuid,
        address: result.serverAddress
      },
      user: result.user
    });
    
  } catch (error) {
    console.error('❌ Server creation error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Assign user to server endpoint
app.post('/assign-user', async (req, res) => {
  try {
    const { serverId, userId, email } = req.body;
    
    if (!serverId || !email) {
      return res.status(400).json({ error: 'serverId and email are required' });
    }
    
    console.log(`\n🎯 API Request: Assign user ${email} to server ${serverId}`);
    
    const result = await AssignUserToServer(serverId, userId, email);
    
    console.log(`🎉 API Response: User assignment result:`, result);
    
    res.json({
      success: true,
      message: 'User assigned to server successfully',
      result: result
    });
    
  } catch (error) {
    console.error('❌ User assignment error:', error.message);
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
    service: 'combined-user-server-management'
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Combined User & Server Management Service running on port ${PORT}`);
  console.log('📍 Available endpoints:');
  console.log('  GET  /debug/env - Check environment variables');
  console.log('  POST /create-user - Create a new user');
  console.log('  POST /create-server - Create a server (requires additional env vars)');
  console.log('  POST /assign-user - Assign user to server');
  console.log('  GET  /users - List all users');
  console.log('  POST /search-user - Search user by email');
  console.log('  GET  /test-api - Test API connectivity');
  console.log('  GET  /health - Health check');
  console.log('\n🧪 Test user creation with:');
  console.log(`  curl -X POST http://localhost:${PORT}/create-user -H "Content-Type: application/json" -d '{"email":"test@example.com"}'`);
  
  if (!process.env.STRIPE_SECRET_KEY || !nodeId || !process.env.PTERODACTYL_EGG_ID) {
    console.log('\n⚠️ Server creation disabled - missing environment variables:');
    if (!process.env.STRIPE_SECRET_KEY) console.log('  - STRIPE_SECRET_KEY');
    if (!nodeId) console.log('  - PTERODACTYL_NODE_ID');
    if (!process.env.PTERODACTYL_EGG_ID) console.log('  - PTERODACTYL_EGG_ID');
  } else {
    console.log('\n✅ Server creation enabled');
  }
});

module.exports = { 
  app, 
  CreateUser, 
  createPterodactylServer, 
  AssignUserToServer, 
  checkServerLimits,
  generateRandomPassword 
};
