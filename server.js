require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');

const PORT = process.env.PORT || 3001;
const API_BASE_URL = process.env.API_BASE_URL || 'https://stripeapibeta.goosehosting.com';

// Environment variable check with detailed logging
console.log('🔍 Environment Check:');
console.log('STRIPE_SECRET_KEY:', process.env.STRIPE_SECRET_KEY ? 'Set (' + process.env.STRIPE_SECRET_KEY.substring(0, 8) + '...)' : 'NOT SET');
console.log('PTERODACTYL_API_KEY:', process.env.PTERODACTYL_API_KEY ? 'Set' : 'NOT SET');
console.log('FRONTEND_URL:', process.env.FRONTEND_URL || 'NOT SET');

// Validate environment variables
const requiredEnvVars = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'PTERODACTYL_API_KEY',
  'PTERODACTYL_API_URL',
  'FRONTEND_URL'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

const app = express();

// Enhanced CORS configuration
const corsOptions = {
  origin: [process.env.FRONTEND_URL, 'http://localhost:5173', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization',
    'X-Requested-With',
    'Accept'
  ],
  credentials: true,
  optionsSuccessStatus: 200
};

// Middleware
app.use(bodyParser.json());
app.use(cors(corsOptions));

// Handle preflight requests
app.options('*', cors(corsOptions));

// Stripe webhook needs raw body
app.use('/webhook', 
  bodyParser.raw({ type: 'application/json' }),
  cors(corsOptions)
);

// Helper functions
const generateCredentials = () => {
  const password = require('crypto').randomBytes(16).toString('hex');
  const username = `user${Math.floor(Math.random() * 10000)}`;
  return { username, password };
};

// Pterodactyl API wrapper with better error handling
const pterodactylRequest = async (method, endpoint, data = null) => {
  try {
    console.log(`🦆 Pterodactyl API: ${method.toUpperCase()} ${endpoint}`);
    const response = await axios({
      method,
      url: `${process.env.PTERODACTYL_API_URL}${endpoint}`,
      headers: {
        'Authorization': `Bearer ${process.env.PTERODACTYL_API_KEY}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      data,
      timeout: 30000 // 30 second timeout
    });
    return response.data;
  } catch (error) {
    console.error('❌ Pterodactyl API Error:', {
      endpoint,
      method,
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      message: error.message
    });
    throw error;
  }
};

// Server creation logic with better error handling
const createMinecraftServer = async (session) => {
  const { customer_details, metadata } = session;
  const email = customer_details?.email || metadata?.customerEmail;
  
  console.log('🚀 Creating Minecraft server for session:', session.id);
  console.log('📧 Customer email:', email);
  console.log('📋 Metadata:', metadata);
  
  if (!email) {
    throw new Error('No customer email available in session');
  }

  let user;
  try {
    // 1. Find or create user
    console.log('👤 Looking for existing user...');
    const users = await pterodactylRequest('get', '/users');
    const existingUser = users.data.find(u => u.attributes.email === email);
    
    if (existingUser) {
      console.log('✅ Found existing user:', existingUser.attributes.username);
      user = {
        id: existingUser.attributes.id,
        username: existingUser.attributes.username,
        isNew: false
      };
    } else {
      console.log('👤 Creating new user...');
      const { username, password } = generateCredentials();
      const newUser = await pterodactylRequest('post', '/users', {
        email,
        username,
        first_name: 'Minecraft',
        last_name: 'Player',
        password
      });
      
      console.log('✅ Created new user:', username);
      user = {
        id: newUser.attributes.id,
        username,
        password,
        isNew: true
      };
    }
  } catch (error) {
    console.error('❌ User creation failed:', error);
    throw new Error(`Failed to setup user account: ${error.message}`);
  }

  try {
    // 2. Get server resources
    console.log('🔍 Getting server resources...');
    const [eggs, nodes] = await Promise.all([
      pterodactylRequest('get', '/nests/1/eggs'),
      pterodactylRequest('get', '/nodes')
    ]);

    const minecraftEgg = eggs.data.find(e => 
      e.attributes.name.toLowerCase().includes('minecraft') ||
      e.attributes.name.toLowerCase().includes('paper') ||
      e.attributes.name.toLowerCase().includes('vanilla')
    );
    
    if (!minecraftEgg) {
      console.error('❌ Available eggs:', eggs.data.map(e => e.attributes.name));
      throw new Error('No Minecraft egg found');
    }
    
    console.log('🥚 Using egg:', minecraftEgg.attributes.name);
    
    const node = nodes.data.find(n => n.attributes.public === true) || nodes.data[0];
    if (!node) {
      throw new Error('No available nodes found');
    }
    
    console.log('🖥️ Using node:', node.attributes.name);
    
    const allocations = await pterodactylRequest(
      'get', 
      `/nodes/${node.attributes.id}/allocations`
    );
    
    const allocation = allocations.data.find(a => !a.attributes.assigned);
    if (!allocation) {
      throw new Error('No available allocations found');
    }
    
    console.log('🔌 Using allocation:', `${allocation.attributes.ip}:${allocation.attributes.port}`);

    // 3. Create server
    console.log('🏗️ Creating server...');
    const serverConfig = {
      name: metadata.serverName || `mc-${Date.now()}`,
      user: user.id,
      egg: minecraftEgg.attributes.id,
      docker_image: minecraftEgg.attributes.docker_image,
      startup: minecraftEgg.attributes.startup,
      environment: {
        SERVER_JARFILE: 'server.jar',
        VERSION: metadata.minecraftVersion || 'latest',
        SERVER_MEMORY: (parseInt(metadata.totalRam) || 4) * 1024,
        BUILD_TYPE: metadata.serverType || 'paper'
      },
      limits: {
        memory: (parseInt(metadata.totalRam) || 4) * 1024,
        disk: 5120,
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

    console.log('📝 Server config:', serverConfig);
    const server = await pterodactylRequest('post', '/servers', serverConfig);
    
    console.log('✅ Server created successfully:', server.attributes.identifier);
    
    return {
      serverId: server.attributes.id,
      identifier: server.attributes.identifier,
      name: server.attributes.name,
      serverIp: allocation.attributes.ip,
      serverPort: allocation.attributes.port,
      username: user.username,
      password: user.isNew ? user.password : undefined,
      panelUrl: process.env.PTERODACTYL_API_URL.replace('/api/application', ''),
      serverName: metadata.serverName,
      serverType: metadata.serverType,
      minecraftVersion: metadata.minecraftVersion,
      totalRam: metadata.totalRam,
      maxPlayers: metadata.maxPlayers,
      viewDistance: metadata.viewDistance,
      enablePvp: metadata.enablePvp === 'true',
      enableWhitelist: metadata.enableWhitelist === 'true',
      selectedPlugins: metadata.selectedPlugins ? metadata.selectedPlugins.split(',') : [],
      isNewUser: user.isNew
    };
  } catch (error) {
    console.error('❌ Server creation failed:', error);
    throw new Error(`Failed to create server: ${error.message}`);
  }
};

// API Endpoints
app.post('/create-checkout-session', async (req, res) => {
  try {
    console.log('💳 Creating checkout session...');
    console.log('📋 Request body:', JSON.stringify(req.body, null, 2));
    
    const { serverConfig, planId } = req.body;
    
    if (!serverConfig?.serverName) {
      return res.status(400).json({ 
        error: 'Server name is required',
        code: 'MISSING_SERVER_NAME'
      });
    }

    // Calculate price based on plan
    const planPrices = {
      starter: 499, // $4.99
      pro: 999,     // $9.99
      elite: 1999   // $19.99
    };

    const basePrice = planPrices[planId] || planPrices.pro;
    const additionalRamCost = Math.round((serverConfig.totalRam - parseInt(serverConfig.baseRam || '4')) * 225); // $2.25 per GB
    const totalPrice = basePrice + Math.max(0, additionalRamCost);

    console.log('💰 Pricing calculation:', {
      plan: planId,
      basePrice,
      additionalRamCost,
      totalPrice
    });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Minecraft Server - ${serverConfig.serverName}`,
            description: `${planId} plan with ${serverConfig.totalRam}GB RAM`
          },
          unit_amount: totalPrice,
          recurring: { interval: 'month' }
        },
        quantity: 1,
      }],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}`,
      customer_email: serverConfig.customerEmail,
      metadata: {
        ...serverConfig,
        planId,
        totalRam: String(serverConfig.totalRam || 4),
        minecraftVersion: serverConfig.minecraftVersion || 'latest',
        serverType: serverConfig.serverType || 'paper',
        maxPlayers: String(serverConfig.maxPlayers || 20),
        viewDistance: String(serverConfig.viewDistance || 10),
        enablePvp: String(serverConfig.enablePvp || true),
        enableWhitelist: String(serverConfig.enableWhitelist || false),
        selectedPlugins: Array.isArray(serverConfig.selectedPlugins) ? serverConfig.selectedPlugins.join(',') : ''
      }
    });

    console.log('✅ Checkout session created:', session.id);

    res.json({ 
      sessionId: session.id,
      url: session.url 
    });

  } catch (error) {
    console.error('❌ Checkout error:', error);
    res.status(500).json({ 
      error: error.message,
      code: 'CHECKOUT_ERROR'
    });
  }
});

// IMPROVED server-details endpoint with better debugging
app.get('/server-details/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    console.log('='.repeat(50));
    console.log(`🔍 SERVER DETAILS REQUEST`);
    console.log('='.repeat(50));
    console.log(`📋 Session ID: ${sessionId}`);
    console.log(`🕐 Timestamp: ${new Date().toISOString()}`);
    console.log(`🌐 Request Origin: ${req.headers.origin || 'Unknown'}`);
    console.log(`🔑 Stripe Key Type: ${process.env.STRIPE_SECRET_KEY?.substring(0, 8)}...`);
    console.log('='.repeat(50));
    
    // Validate session ID format
    if (!sessionId || !sessionId.startsWith('cs_')) {
      console.log('❌ Invalid session ID format:', sessionId);
      return res.status(400).json({ 
        error: 'Invalid session ID format',
        code: 'INVALID_SESSION_ID',
        expected: 'Session ID should start with cs_',
        received: sessionId
      });
    }

    // Step 1: Try to retrieve session from Stripe
    let session;
    try {
      console.log('🔄 Retrieving session from Stripe...');
      session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ['customer', 'subscription']
      });
      
      console.log('✅ Session retrieved successfully:');
      console.log(`   - ID: ${session.id}`);
      console.log(`   - Status: ${session.status}`);
      console.log(`   - Payment Status: ${session.payment_status}`);
      console.log(`   - Amount: $${(session.amount_total / 100).toFixed(2)}`);
      console.log(`   - Customer Email: ${session.customer_details?.email || 'N/A'}`);
      console.log(`   - Created: ${new Date(session.created * 1000).toISOString()}`);
      console.log(`   - Metadata Keys: [${Object.keys(session.metadata || {}).join(', ')}]`);
      
    } catch (stripeError) {
      console.error('❌ Stripe session retrieval failed:');
      console.error(`   - Error Type: ${stripeError.type}`);
      console.error(`   - Error Code: ${stripeError.code}`);
      console.error(`   - Error Message: ${stripeError.message}`);
      console.error(`   - Request ID: ${stripeError.requestId || 'N/A'}`);
      
      if (stripeError.type === 'StripeInvalidRequestError') {
        // Check if it's a test/live key mismatch
        const isTestSession = sessionId.includes('test_');
        const isTestKey = process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_');
        
        if (isTestSession && !isTestKey) {
          return res.status(404).json({ 
            error: 'Test session with live Stripe key',
            code: 'STRIPE_KEY_MISMATCH',
            details: 'You are trying to access a test session with a live Stripe key. Please use a test key.',
            sessionType: 'test',
            keyType: 'live'
          });
        } else if (!isTestSession && isTestKey) {
          return res.status(404).json({ 
            error: 'Live session with test Stripe key',
            code: 'STRIPE_KEY_MISMATCH',
            details: 'You are trying to access a live session with a test Stripe key. Please use a live key.',
            sessionType: 'live',
            keyType: 'test'
          });
        }
        
        return res.status(404).json({ 
          error: 'Session not found in Stripe',
          code: 'STRIPE_SESSION_NOT_FOUND',
          details: stripeError.message,
          sessionId: sessionId,
          timestamp: new Date().toISOString()
        });
      }
      
      return res.status(500).json({
        error: 'Stripe API error',
        code: 'STRIPE_API_ERROR',
        details: stripeError.message
      });
    }

    // Step 2: Check payment status
    console.log('💳 Checking payment status...');
    if (session.payment_status !== 'paid') {
      console.log(`💸 Payment not completed: ${session.payment_status}`);
      return res.status(202).json({ 
        status: 'payment_pending',
        paymentStatus: session.payment_status,
        sessionId: session.id,
        message: 'Payment is still being processed'
      });
    }

    // Step 3: Check if server already created
    console.log('🏗️ Checking server creation status...');
    if (session.metadata.serverCreated === 'true') {
      console.log('✅ Server already created, returning existing details');
      return res.json({
        status: 'ready',
        server: {
          serverName: session.metadata.serverName,
          serverIp: session.metadata.serverIp,
          serverPort: session.metadata.serverPort,
          serverId: session.metadata.serverId,
          panelUrl: process.env.PTERODACTYL_API_URL.replace('/api/application', ''),
          serverType: session.metadata.serverType,
          minecraftVersion: session.metadata.minecraftVersion,
          totalRam: session.metadata.totalRam,
          maxPlayers: session.metadata.maxPlayers,
          viewDistance: session.metadata.viewDistance,
          enablePvp: session.metadata.enablePvp === 'true',
          enableWhitelist: session.metadata.enableWhitelist === 'true',
          selectedPlugins: session.metadata.selectedPlugins ? session.metadata.selectedPlugins.split(',') : []
        }
      });
    }

    // Step 4: Create server since payment is complete
    console.log('🚀 Payment completed, creating server...');
    console.log('📝 Session metadata for server creation:');
    console.log(JSON.stringify(session.metadata, null, 2));
    
    try {
      const serverDetails = await createMinecraftServer(session);
      
      // Step 5: Update session metadata with server details
      console.log('📝 Updating session metadata with server details...');
      await stripe.checkout.sessions.update(sessionId, {
        metadata: {
          ...session.metadata,
          serverCreated: 'true',
          serverIp: serverDetails.serverIp,
          serverPort: serverDetails.serverPort,
          serverId: serverDetails.serverId,
          serverIdentifier: serverDetails.identifier
        }
      });

      console.log('✅ Server created and session updated successfully');
      console.log('🎉 Server deployment complete!');

      res.json({
        status: 'ready',
        server: serverDetails
      });

    } catch (serverError) {
      console.error('❌ Server creation failed:');
      console.error(`   - Error: ${serverError.message}`);
      console.error(`   - Stack: ${serverError.stack}`);
      
      // Try to update session with error info
      try {
        await stripe.checkout.sessions.update(sessionId, {
          metadata: {
            ...session.metadata,
            serverCreated: 'false',
            serverError: serverError.message,
            errorTimestamp: new Date().toISOString()
          }
        });
      } catch (updateError) {
        console.error('❌ Failed to update session with error:', updateError.message);
      }
      
      return res.status(500).json({
        error: 'Server deployment failed',
        details: serverError.message,
        code: 'SERVER_CREATION_FAILED',
        sessionId: sessionId,
        timestamp: new Date().toISOString()
      });
    }

  } catch (error) {
    console.error('❌ Unexpected server details error:', error);
    
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message,
      code: 'SERVER_DETAILS_ERROR',
      timestamp: new Date().toISOString()
    });
  }
});

// Enhanced debug endpoint to check sessions
app.get('/debug/sessions', async (req, res) => {
  try {
    console.log('📋 Listing recent Stripe sessions...');
    
    const sessions = await stripe.checkout.sessions.list({
      limit: 10,
      expand: ['data.customer']
    });
    
    const sessionSummary = sessions.data.map(session => ({
      id: session.id,
      status: session.status,
      payment_status: session.payment_status,
      customer_email: session.customer_details?.email,
      amount: session.amount_total,
      created: new Date(session.created * 1000).toISOString(),
      metadata_keys: Object.keys(session.metadata || {})
    }));
    
    res.json({
      total_sessions: sessions.data.length,
      sessions: sessionSummary,
      environment: {
        stripe_key_type: process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_') ? 'test' : 'live'
      }
    });
    
  } catch (error) {
    console.error('❌ Failed to list sessions:', error.message);
    res.status(500).json({
      error: error.message,
      type: error.type
    });
  }
});

// Enhanced debug endpoint for specific sessions
app.get('/debug/stripe/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    console.log('🔍 Debug request for session:', sessionId);
    
    // Test Stripe connection first
    try {
      const balance = await stripe.balance.retrieve();
      console.log('✅ Stripe connection successful');
    } catch (connectionError) {
      console.error('❌ Stripe connection failed:', connectionError.message);
      return res.status(500).json({
        error: 'Stripe connection failed',
        details: connectionError.message,
        suggestion: 'Check your STRIPE_SECRET_KEY environment variable'
      });
    }
    
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['customer', 'subscription']
    });
    
    console.log('✅ Session found:', {
      id: session.id,
      status: session.status,
      payment_status: session.payment_status,
      customer_email: session.customer_details?.email,
      metadata_keys: Object.keys(session.metadata || {})
    });
    
    res.json({
      session: {
        id: session.id,
        status: session.status,
        payment_status: session.payment_status,
        metadata: session.metadata,
        customer_details: session.customer_details,
        amount_total: session.amount_total,
        currency: session.currency,
        created: new Date(session.created * 1000).toISOString(),
        stripe_account: session.livemode ? 'live' : 'test'
      },
      environment: {
        stripe_key_type: process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_') ? 'test' : 'live',
        api_base_url: API_BASE_URL,
        frontend_url: process.env.FRONTEND_URL
      }
    });
  } catch (error) {
    console.error('❌ Debug session error:', error.message);
    res.status(500).json({ 
      error: error.message,
      type: error.type,
      code: error.code,
      suggestion: error.type === 'StripeInvalidRequestError' ? 
        'Session may not exist or there might be a test/live key mismatch' : 
        'Check server logs for more details'
    });
  }
});

// Stripe webhook handler
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('❌ Webhook verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  console.log(`📨 Webhook received: ${event.type}`);
  
  // Handle different event types
  switch (event.type) {
    case 'checkout.session.completed':
      console.log('✅ Checkout session completed:', event.data.object.id);
      break;
    case 'customer.subscription.created':
      console.log('📋 Subscription created:', event.data.object.id);
      break;
    case 'invoice.payment_succeeded':
      console.log('💰 Payment succeeded:', event.data.object.id);
      break;
    case 'invoice.payment_failed':
      console.log('❌ Payment failed:', event.data.object.id);
      break;
    default:
      console.log(`🤷 Unhandled event type: ${event.type}`);
  }

  res.json({ received: true });
});

// Health check endpoint with full environment info
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    api: API_BASE_URL,
    stripe: process.env.STRIPE_SECRET_KEY ? 'configured' : 'missing',
    stripe_mode: process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_') ? 'test' : 'live',
    pterodactyl: process.env.PTERODACTYL_API_URL,
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    version: '2.0.0', // Updated version
    endpoints: [
      'POST /create-checkout-session',
      'GET /server-details/:sessionId',
      'GET /debug/stripe/:sessionId',
      'GET /debug/sessions',
      'GET /health',
      'POST /webhook'
    ]
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('🚨 Global error handler:', err);
  res.status(500).json({
    error: 'Internal server error',
    code: 'INTERNAL_SERVER_ERROR',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong',
    timestamp: new Date().toISOString()
  });
});

// 404 handler with available endpoints
app.use((req, res) => {
  console.log(`❌ 404 - Route not found: ${req.method} ${req.path}`);
  res.status(404).json({
    error: 'Route not found',
    code: 'NOT_FOUND',
    path: req.path,
    method: req.method,
    available_endpoints: [
      'POST /create-checkout-session',
      'GET /server-details/:sessionId',
      'GET /debug/stripe/:sessionId',
      'GET /debug/sessions',
      'GET /health',
      'POST /webhook'
    ],
    message: 'The requested endpoint does not exist on this server',
    timestamp: new Date().toISOString()
  });
});

// Start server
app.listen(PORT, () => {
  console.log('🦆 GoosePanel Backend Server Started!');
  console.log('==========================================');
  console.log(`🚀 Server running on ${API_BASE_URL}`);
  console.log(`🔗 CORS enabled for: ${process.env.FRONTEND_URL}`);
  console.log(`💳 Stripe mode: ${process.env.STRIPE_SECRET_KEY?.startsWith('sk_test') ? 'TEST' : 'LIVE'}`);
  console.log(`🎮 Pterodactyl API: ${process.env.PTERODACTYL_API_URL}`);
  console.log(`📧 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📊 Version: 2.0.0 (Updated with debugging)`);
  console.log('==========================================');
  console.log('Available endpoints:');
  console.log('  POST /create-checkout-session');
  console.log('  GET  /server-details/:sessionId');
  console.log('  GET  /debug/stripe/:sessionId');
  console.log('  GET  /debug/sessions');
  console.log('  GET  /health');
  console.log('  POST /webhook');
  console.log('==========================================');
});
