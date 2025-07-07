// server.js - FIXED VERSION with proper billing intervals
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
    'http://localhost:3000',
    'http://localhost:5173'
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
const nodeId = process.env.PTERODACTYL_NODE_ID;

// FIXED: Java version mapping for Minecraft versions (Updated for Java 21 LTS)
const getJavaVersionForMinecraft = (minecraftVersion) => {
  if (!minecraftVersion) return { java: 21, image: 'ghcr.io/pterodactyl/yolks:java_21' };
  
  // Parse version string to compare properly
  const parseVersion = (version) => {
    const parts = version.replace(/[^0-9.]/g, '').split('.').map(Number);
    return {
      major: parts[0] || 1,
      minor: parts[1] || 0,
      patch: parts[2] || 0
    };
  };
  
  const version = parseVersion(minecraftVersion);
  
  console.log(`🔍 Determining Java version for Minecraft ${minecraftVersion}:`, version);
  
  // Minecraft 1.20.5+ works best with Java 21 (latest LTS)
  if (version.major > 1 || (version.major === 1 && version.minor >= 21)) {
    console.log('✅ Using Java 21 for Minecraft 1.21+');
    return {
      java: 21,
      image: 'ghcr.io/pterodactyl/yolks:java_21',
      startup: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}'
    };
  }
  
  // Minecraft 1.20.x works well with Java 21 but also supports Java 17
  if (version.major === 1 && version.minor === 20) {
    console.log('✅ Using Java 21 for Minecraft 1.20.x (optimal performance)');
    return {
      java: 21,
      image: 'ghcr.io/pterodactyl/yolks:java_21',
      startup: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}'
    };
  }
  
  // Minecraft 1.17-1.19 requires Java 17+, but Java 21 works better
  if (version.major === 1 && version.minor >= 17 && version.minor <= 19) {
    console.log('✅ Using Java 21 for Minecraft 1.17-1.19 (backwards compatible)');
    return {
      java: 21,
      image: 'ghcr.io/pterodactyl/yolks:java_21',
      startup: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}'
    };
  }
  
  // Minecraft 1.16.x requires Java 11+ (but Java 17 is better)
  if (version.major === 1 && version.minor === 16) {
    console.log('✅ Using Java 17 for Minecraft 1.16.x');
    return {
      java: 17,
      image: 'ghcr.io/pterodactyl/yolks:java_17',
      startup: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}'
    };
  }
  
  // Minecraft 1.12-1.15 works with Java 8, but Java 11 is more stable
  if (version.major === 1 && version.minor >= 12 && version.minor <= 15) {
    console.log('✅ Using Java 11 for Minecraft 1.12-1.15 (better stability)');
    return {
      java: 11,
      image: 'ghcr.io/pterodactyl/yolks:java_11',
      startup: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}'
    };
  }
  
  // Older versions (1.8-1.11) need Java 8 for compatibility
  if (version.major === 1 && version.minor >= 8 && version.minor <= 11) {
    console.log('✅ Using Java 8 for Minecraft 1.8-1.11 (required for compatibility)');
    return {
      java: 8,
      image: 'ghcr.io/pterodactyl/yolks:java_8',
      startup: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}'
    };
  }
  
  // Default to Java 21 for unknown/latest versions (future-proof)
  console.log('⚠️ Unknown version, defaulting to Java 21 (latest LTS)');
  return {
    java: 21,
    image: 'ghcr.io/pterodactyl/yolks:java_21',
    startup: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}'
  };
};

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

// Username and password generators (unchanged)
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

// Create User function (unchanged)
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

    // Check for existing user
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
        password: null
      };
    }

    // Generate credentials and create user
    const username = generateUsernameFromEmail(email);
    const password = generateRandomPassword(16);
    console.log(`Generated credentials - Username: ${username}`);

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
    console.error('User creation failed:', error.message);
    throw new Error(`User creation failed: ${error.message}`);
  }
};

// In-memory session store
const sessionCredentialsStore = new Map();

// FIXED: Create Pterodactyl Server with proper Java version support
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
    const minecraftVersion = session.metadata?.minecraftVersion || '1.21.4';
    const serverType = session.metadata?.serverType || 'paper';
    
    // STEP 3: Get correct Java version and Docker image
    const javaConfig = getJavaVersionForMinecraft(minecraftVersion);
    console.log('☕ Java configuration:', javaConfig);
    
    // STEP 4: Get available allocation
    const allocRes = await pterodactylRequest('GET', `/nodes/${nodeId}/allocations`);
    const availableAllocations = allocRes.data.data.filter(a => !a.attributes.assigned);
    
    if (availableAllocations.length === 0) {
      throw new Error('No available server ports on this node');
    }
    
    const allocation = availableAllocations[0];
    console.log(`🎯 Using allocation: ${allocation.attributes.id}`);
    
    // STEP 5: Create server with correct Java configuration
    const serverData = {
      name: serverName,
      user: parseInt(userResult.userId),
      egg: parseInt(process.env.PTERODACTYL_EGG_ID),
      docker_image: javaConfig.image, // Use correct Java image
      startup: javaConfig.startup,     // Use correct startup command
      environment: {
        SERVER_JARFILE: 'server.jar',
        SERVER_MEMORY: totalRam * 1024,
        MAX_PLAYERS: parseInt(session.metadata?.maxPlayers) || 20,
        EULA: 'true',
        BUILD_NUMBER: 'latest',
        VERSION: minecraftVersion,
        SERVER_TYPE: serverType.toUpperCase(), // PAPER, SPIGOT, etc.
        JAVA_VERSION: javaConfig.java.toString() // Store Java version for reference
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
    
    console.log('🔨 Creating server with configuration:', {
      name: serverData.name,
      image: serverData.docker_image,
      java: javaConfig.java,
      minecraft: minecraftVersion,
      type: serverType
    });
    
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
      address: serverAddress,
      java: javaConfig.java,
      image: javaConfig.image
    });
    
    // STEP 6: Prepare credentials and server info
    const serverInfo = {
      serverId: serverId,
      serverUuid: serverUuid,
      serverAddress: serverAddress,
      pterodactylUserId: userResult.userId,
      pterodactylUsername: userResult.username,
      ownerEmail: customerEmail,
      createdAt: new Date().toISOString(),
      userStatus: userResult.existing ? 'existing' : 'new',
      javaVersion: javaConfig.java,
      dockerImage: javaConfig.image,
      minecraftVersion: minecraftVersion,
      serverType: serverType
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

    // STEP 7: Try to update Stripe session
    if (stripe && session.id) {
      try {
        console.log('🔄 Attempting to update Stripe session metadata...');
        
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

// Get session details endpoint (unchanged except for better logging)
app.get('/session-details/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }

    console.log(`\n🔍 Fetching session details for: ${sessionId}`);

    let session = null;
    let metadata = {};

    if (stripe) {
      try {
        session = await stripe.checkout.sessions.retrieve(sessionId);
        metadata = session.metadata || {};
        console.log('📋 Session found from Stripe:', {
          id: session.id,
          status: session.payment_status,
          email: session.customer_details?.email,
          hasCredentials: !!(metadata.serverUsername),
          hasServer: !!(metadata.serverId)
        });
      } catch (stripeError) {
        console.warn('⚠️ Failed to retrieve from Stripe:', stripeError.message);
      }
    }

    const memoryData = sessionCredentialsStore.get(sessionId);
    if (memoryData) {
      console.log('💾 Found additional data in memory store');
      metadata = { ...metadata, ...memoryData };
    }

    if (!session && !memoryData) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (!session && memoryData) {
      session = {
        id: sessionId,
        payment_status: 'paid',
        customer_details: { email: memoryData.ownerEmail },
        metadata: memoryData
      };
    }

    if (session.payment_status === 'paid' && !metadata.serverId) {
      console.log('💰 Payment confirmed, creating server...');
      
      try {
        const serverResult = await createPterodactylServer(session);
        console.log('🎉 Server created successfully');
        
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

// FIXED: Create checkout session endpoint with proper billing intervals
app.post('/create-checkout-session', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: 'Stripe not configured' });
    }

    const serverConfig = req.body.serverConfig || req.body;
    const planId = req.body.planId || req.body.plan;
    const billingCycle = req.body.billingCycle || 'monthly';

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
      totalCost,
      monthlyCost,
      effectiveMonthlyRate,
      discount,
      savings
    } = serverConfig;

    if (!serverName || !planId || (!totalCost && !monthlyCost)) {
      return res.status(400).json({ 
        error: 'Missing required fields: serverName, plan, and totalCost/monthlyCost are required'
      });
    }

    console.log('💳 Creating Stripe checkout session:', {
      serverName,
      plan: planId,
      billingCycle,
      totalCost,
      monthlyCost,
      effectiveMonthlyRate,
      minecraftVersion,
      serverType
    });

    // FIXED: Map billing cycles to Stripe intervals and calculate correct pricing
    const billingIntervalMap = {
      'monthly': { interval: 'month', interval_count: 1 },
      'quarterly': { interval: 'month', interval_count: 3 },
      'semiannual': { interval: 'month', interval_count: 6 },
      'annual': { interval: 'year', interval_count: 1 }
    };

    const stripeInterval = billingIntervalMap[billingCycle] || billingIntervalMap['monthly'];
    
    // Calculate the correct amount based on billing cycle
    let unitAmount;
    let description;
    
    if (billingCycle === 'monthly') {
      unitAmount = Math.round((monthlyCost || effectiveMonthlyRate || 9.99) * 100);
      description = `Minecraft Server (${serverType} ${minecraftVersion}) - Monthly`;
    } else {
      // For non-monthly billing, use the total cost for the period
      unitAmount = Math.round((totalCost || monthlyCost || 9.99) * 100);
      const periodNames = {
        'quarterly': '3 months',
        'semiannual': '6 months', 
        'annual': '12 months'
      };
      description = `Minecraft Server (${serverType} ${minecraftVersion}) - ${periodNames[billingCycle] || billingCycle}`;
    }

    console.log('💰 Stripe pricing calculation:', {
      billingCycle,
      stripeInterval,
      unitAmount: unitAmount / 100,
      description
    });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${serverName} - ${planId.toUpperCase()} Plan`,
            description: description
          },
          recurring: {
            interval: stripeInterval.interval,
            interval_count: stripeInterval.interval_count
          },
          unit_amount: unitAmount
        },
        quantity: 1
      }],
      mode: 'subscription',
      success_url: `https://beta.goosehosting.com/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://beta.goosehosting.com/cancel`,
      metadata: {
        serverName: serverName || 'Unnamed Server',
        plan: planId || 'custom',
        serverType: serverType || 'paper',
        minecraftVersion: minecraftVersion || '1.21.4',
        totalRam: (totalRam || 4).toString(),
        maxPlayers: (maxPlayers || 20).toString(),
        viewDistance: (viewDistance || 10).toString(),
        whitelist: (whitelist || false).toString(),
        pvp: (pvp !== false).toString(),
        plugins: Array.isArray(plugins) ? plugins.join(',') : (plugins || 'none'),
        billingCycle: billingCycle,
        totalCost: (totalCost || 0).toString(),
        monthlyCost: (monthlyCost || 0).toString(),
        effectiveMonthlyRate: (effectiveMonthlyRate || 0).toString(),
        discount: (discount || 0).toString(),
        savings: (savings || 0).toString()
      }
    });

    console.log('✅ Stripe session created:', {
      sessionId: session.id,
      billingCycle,
      interval: stripeInterval,
      amount: unitAmount / 100
    });

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
  console.log('\n☕ Java version mapping (Updated for Java 21 LTS):');
  console.log('  Minecraft 1.21+ → Java 21 (Latest LTS)');
  console.log('  Minecraft 1.20.x → Java 21 (Optimal)');
  console.log('  Minecraft 1.17-1.19 → Java 21 (Backwards Compatible)');
  console.log('  Minecraft 1.16.x → Java 17');
  console.log('  Minecraft 1.12-1.15 → Java 11');
  console.log('  Minecraft 1.8-1.11 → Java 8');
  
  if (!stripe || !nodeId || !process.env.PTERODACTYL_EGG_ID) {
    console.log('\n⚠️ Server creation partially disabled - missing environment variables');
    if (!stripe) console.log('  - Stripe not configured');
    if (!nodeId) console.log('  - PTERODACTYL_NODE_ID missing');
    if (!process.env.PTERODACTYL_EGG_ID) console.log('  - PTERODACTYL_EGG_ID missing');
  } else {
    console.log('\n✅ Server creation enabled with proper Java version support');
  }
});

module.exports = { 
  app, 
  CreateUser, 
  createPterodactylServer, 
  generateRandomPassword,
  getJavaVersionForMinecraft
};
