// server.js - FIXED VERSION - Resolves stripe.checkout.sessions.update issue
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

// Fix: Initialize Stripe properly with error handling
let stripe;
try {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.warn('⚠️ STRIPE_SECRET_KEY not found in environment variables');
    stripe = null;
  } else {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    console.log('✅ Stripe initialized successfully');
  }
} catch (error) {
  console.error('❌ Failed to initialize Stripe:', error.message);
  stripe = null;
}

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
  
  const missingRequired = requiredVars.filter(varName => !process.env[varName]);
  if (missingRequired.length > 0) {
    console.error('❌ Missing required environment variables:', missingRequired.join(', '));
    process.exit(1);
  }
};

validateEnvVars();

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
    .slice(0, 10);

  if (username.length < 4) {
    username += 'user';
  }

  const suffix = Math.floor(Math.random() * 9000 + 1000);
  return `${username}${suffix}`.slice(0, 16);
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

// MAIN FUNCTION: Create User (Returns credentials for storing in metadata)
const CreateUser = async (email) => {
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
        admin: user.root_admin,
        password: null // Don't return password for existing users
      };
    }

    // 2. Generate username and password
    const username = generateUsernameFromEmail(email);
    const password = generateRandomPassword(16);
    console.log(`Generated credentials - Username: ${username}`);

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
      password: password, // Return password for new users
      existing: false,
      admin: createResponse.data.attributes.root_admin
    };

  } catch (error) {
    console.error('User creation failed:', error.message);
    throw new Error(`User creation failed: ${error.message}`);
  }
};

// In-memory session store for when Stripe update fails
const sessionCredentialsStore = new Map();

// FIXED: Create Pterodactyl Server function with better error handling
async function createPterodactylServer(session) {
  if (!nodeId || !process.env.PTERODACTYL_EGG_ID) {
    throw new Error('Server creation requires PTERODACTYL_NODE_ID and PTERODACTYL_EGG_ID');
  }

  try {
    console.log('🚀 Starting server creation process');
    
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
      existing: userResult.existing,
      hasPassword: !!userResult.password
    });
    
    // STEP 2: Extract server settings from session metadata
    const serverName = session.metadata?.serverName || `Server-${Date.now()}`;
    const totalRam = parseInt(session.metadata?.totalRam) || 4;
    
    // STEP 3: Get available allocation
    const allocRes = await pterodactylRequest('GET', `/nodes/${nodeId}/allocations`);
    const availableAllocations = allocRes.data.data.filter(a => !a.attributes.assigned);
    
    if (availableAllocations.length === 0) {
      throw new Error('No available server ports on this node');
    }
    
    const allocation = availableAllocations[0];
    console.log(`🎯 Using allocation: ${allocation.attributes.id}`);
    
    // STEP 4: Create server
    const serverData = {
      name: serverName,
      user: parseInt(userResult.userId),
      egg: parseInt(process.env.PTERODACTYL_EGG_ID),
      docker_image: 'ghcr.io/pterodactyl/yolks:java_17',
      startup: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}',
      environment: {
        SERVER_JARFILE: 'server.jar',
        SERVER_MEMORY: totalRam * 1024,
        MAX_PLAYERS: parseInt(session.metadata?.maxPlayers) || 20,
        EULA: 'true',
        BUILD_NUMBER: 'latest',
        VERSION: session.metadata?.minecraftVersion || '1.21.3'
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
    
    const response = await axios.post(
      `${PTERODACTYL_BASE}/servers`, 
      serverData, 
      {
        headers: {
          'Authorization': `Bearer ${PTERODACTYL_API_KEY}`,
          'Content-Type': 'application/json',
          'Accept': 'Application/vnd.pterodactyl.v1+json'
        }
      }
    );
    
    const serverId = response.data.attributes.id;
    const serverUuid = response.data.attributes.uuid;
    const serverAddress = `mc.goosehosting.com:${allocation.attributes.port}`;
    
    console.log('🎉 Server created successfully:', {
      id: serverId,
      uuid: serverUuid,
      address: serverAddress
    });
    
    // STEP 5: Prepare credentials and server info
    const serverInfo = {
      serverId: serverId,
      serverUuid: serverUuid,
      serverAddress: serverAddress,
      pterodactylUserId: userResult.userId,
      pterodactylUsername: userResult.username,
      ownerEmail: customerEmail,
      createdAt: new Date().toISOString(),
      userStatus: userResult.existing ? 'existing' : 'new'
    };

    // Only add credentials for new users
    if (!userResult.existing && userResult.password) {
      serverInfo.serverUsername = userResult.username;
      serverInfo.serverPassword = userResult.password;
      serverInfo.ftpHost = 'ftp.goosehosting.com';
      serverInfo.ftpPort = '21';
      serverInfo.ftpUsername = userResult.username;
      serverInfo.ftpPassword = userResult.password;
    }

    // STEP 6: Try to update Stripe session, but don't fail if it doesn't work
    if (stripe && session.id) {
      try {
        console.log('🔄 Attempting to update Stripe session metadata...');
        
        // Verify stripe.checkout.sessions.update exists
        if (typeof stripe.checkout?.sessions?.update !== 'function') {
          throw new Error('stripe.checkout.sessions.update is not available');
        }
        
        const updateMetadata = {
          ...session.metadata,
          ...serverInfo
        };

        await stripe.checkout.sessions.update(session.id, {
          metadata: updateMetadata
        });
        
        console.log('✅ Updated Stripe session with credentials');
      } catch (stripeError) {
        console.warn('⚠️ Failed to update Stripe session, storing in memory:', stripeError.message);
        
        // Store in memory as fallback
        sessionCredentialsStore.set(session.id, {
          ...session.metadata,
          ...serverInfo
        });
        
        console.log('💾 Stored credentials in memory store as fallback');
      }
    } else {
      console.warn('⚠️ Stripe not available, storing credentials in memory');
      sessionCredentialsStore.set(session.id, {
        ...session.metadata,
        ...serverInfo
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
        username: userResult.username,
        password: userResult.password,
        existing: userResult.existing
      },
      credentials: serverInfo
    };
    
  } catch (err) {
    console.error('❌ Server creation failed:', err.message);
    throw err;
  }
}

// FIXED: Get Stripe session details with fallback to memory store
app.get('/session-details/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }

    console.log(`\n🔍 Fetching session details for: ${sessionId}`);

    let session = null;
    let metadata = {};

    // Try to get session from Stripe if available
    if (stripe) {
      try {
        session = await stripe.checkout.sessions.retrieve(sessionId);
        metadata = session.metadata || {};
        console.log('📋 Session found from Stripe:', {
          id: session.id,
          status: session.payment_status,
          email: session.customer_details?.email,
          hasCredentials: !!(metadata.serverUsername)
        });
      } catch (stripeError) {
        console.warn('⚠️ Failed to retrieve from Stripe:', stripeError.message);
      }
    }

    // Check memory store for additional data
    const memoryData = sessionCredentialsStore.get(sessionId);
    if (memoryData) {
      console.log('💾 Found additional data in memory store');
      metadata = { ...metadata, ...memoryData };
    }

    // If no session found anywhere, return error
    if (!session && !memoryData) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Create mock session if only memory data exists
    if (!session && memoryData) {
      session = {
        id: sessionId,
        payment_status: 'paid',
        customer_details: { email: memoryData.ownerEmail },
        metadata: memoryData
      };
    }

    // Check if session is paid and server hasn't been created yet
    if (session.payment_status === 'paid' && !metadata.serverId) {
      console.log('💰 Payment confirmed, creating server...');
      
      try {
        const serverResult = await createPterodactylServer(session);
        
        console.log('🎉 Server created successfully');
        
        // Update metadata with the new server info
        metadata = { ...metadata, ...serverResult.credentials };
        
        return res.json({
          success: true,
          session: {
            id: session.id,
            status: session.payment_status,
            customer_email: session.customer_details?.email,
            metadata: metadata
          },
          server: {
            id: serverResult.serverId,
            uuid: serverResult.serverUuid,
            address: serverResult.serverAddress,
            user: serverResult.user
          },
          message: 'Server created successfully'
        });
        
      } catch (serverError) {
        console.error('❌ Server creation failed:', serverError.message);
        
        return res.json({
          success: false,
          session: {
            id: session.id,
            status: session.payment_status,
            customer_email: session.customer_details?.email,
            metadata: metadata
          },
          error: `Server creation failed: ${serverError.message}`,
          message: 'Payment successful but server creation failed'
        });
      }
    }

    // Session exists - return current state with credentials if available
    return res.json({
      success: true,
      session: {
        id: session.id,
        status: session.payment_status,
        customer_email: session.customer_details?.email,
        metadata: metadata
      },
      message: session.payment_status === 'paid' ? 'Server already exists' : 'Payment pending'
    });

  } catch (error) {
    console.error('❌ Session details error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Create Stripe checkout session (No changes needed)
app.post('/create-checkout-session', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: 'Stripe not configured' });
    }

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

    if (!serverName || !planId || !totalCost) {
      return res.status(400).json({ 
        error: 'Missing required fields: serverName, plan, and totalCost are required'
      });
    }

    console.log('💳 Creating Stripe checkout session:', {
      serverName,
      plan: planId,
      totalCost
    });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${serverName} - ${planId.toUpperCase()} Plan`,
            description: `Minecraft Server (${serverType} ${minecraftVersion})`
          },
          recurring: {
            interval: 'month'
          },
          unit_amount: Math.round(parseFloat(totalCost || 9.99) * 100)
        },
        quantity: 1
      }],
      mode: 'subscription',
      success_url: `https://beta.goosehosting.com/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://beta.goosehosting.com/cancel`,
      metadata: {
        serverName: serverName || 'Unnamed Server',
        plan: planId || 'custom',
        serverType: serverType || 'vanilla',
        minecraftVersion: minecraftVersion || '1.20',
        totalRam: (totalRam || 4).toString(),
        maxPlayers: (maxPlayers || 20).toString(),
        viewDistance: (viewDistance || 10).toString(),
        whitelist: (whitelist || false).toString(),
        pvp: (pvp !== false).toString(),
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

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'combined-user-server-management',
    stripe: !!stripe,
    memoryStore: sessionCredentialsStore.size
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Combined User & Server Management Service running on port ${PORT}`);
  console.log('📍 Available endpoints:');
  console.log('  GET  /session-details/:sessionId - Get session and server details');
  console.log('  POST /create-checkout-session - Create Stripe checkout');
  console.log('  GET  /health - Health check');
  
  if (!stripe || !nodeId || !process.env.PTERODACTYL_EGG_ID) {
    console.log('\n⚠️ Server creation partially disabled - missing environment variables');
    if (!stripe) console.log('  - Stripe not configured');
    if (!nodeId) console.log('  - PTERODACTYL_NODE_ID missing');
    if (!process.env.PTERODACTYL_EGG_ID) console.log('  - PTERODACTYL_EGG_ID missing');
  } else {
    console.log('\n✅ Server creation enabled with credentials storage');
  }
});

module.exports = { 
  app, 
  CreateUser, 
  createPterodactylServer, 
  generateRandomPassword 
};
