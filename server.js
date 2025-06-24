require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');

const PORT = process.env.PORT || 3001;
const API_BASE_URL = process.env.API_BASE_URL || 'https://stripeapibeta.goosehosting.com';

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
      ip: allocation.attributes.ip,
      port: allocation.attributes.port,
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

app.get('/server-details/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    console.log(`🔍 Fetching server details for session: ${sessionId}`);
    console.log(`📊 Request details:`, {
      method: req.method,
      url: req.url,
      headers: {
        'user-agent': req.headers['user-agent'],
        'origin': req.headers.origin
      }
    });
    
    if (!sessionId || !sessionId.startsWith('cs_')) {
      console.log('❌ Invalid session ID format:', sessionId);
      return res.status(400).json({ 
        error: 'Invalid session ID format',
        code: 'INVALID_SESSION_ID'
      });
    }

    // Retrieve session with expanded data
    let session;
    try {
      console.log('🔄 Retrieving session from Stripe...');
      session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ['customer', 'subscription']
      });
      console.log('✅ Session retrieved successfully:', {
        id: session.id,
        status: session.status,
        payment_status: session.payment_status,
        amount_total: session.amount_total
      });
    } catch (stripeError) {
      console.error('❌ Stripe session retrieval failed:', {
        error: stripeError.message,
        type: stripeError.type,
        code: stripeError.code
      });
      
      if (stripeError.type === 'StripeInvalidRequestError') {
        return res.status(404).json({ 
          error: 'Session not found in Stripe',
          code: 'STRIPE_SESSION_NOT_FOUND',
          details: stripeError.message
        });
      }
      throw stripeError;
    }

    // Handle payment status
    if (session.payment_status !== 'paid') {
      console.log('💳 Payment not completed yet:', session.payment_status);
      return res.status(202).json({ 
        status: 'payment_pending',
        paymentStatus: session.payment_status,
        sessionId: session.id
      });
    }

    // Check if server already created
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

    // Create server since payment is complete
    console.log('🚀 Payment completed, creating server...');
    
    try {
      const serverDetails = await createMinecraftServer(session);
      
      // Update session metadata with server details
      await stripe.checkout.sessions.update(sessionId, {
        metadata: {
          ...session.metadata,
          serverCreated: 'true',
          serverIp: serverDetails.ip,
          serverPort: serverDetails.port,
          serverId: serverDetails.serverId,
          serverIdentifier: serverDetails.identifier
        }
      });

      console.log('✅ Server created and session updated successfully');

      res.json({
        status: 'ready',
        server: serverDetails
      });

    } catch (serverError) {
      console.error('❌ Server creation failed:', serverError);
      
      return res.status(500).json({
        error: 'Server deployment failed',
        details: serverError.message,
        code: 'SERVER_CREATION_FAILED'
      });
    }

  } catch (error) {
    console.error('❌ Server details error:', error);
    
    res.status(500).json({ 
      error: error.message,
      code: 'SERVER_DETAILS_ERROR'
    });
  }
});

// Stripe webhook handler (for future use)
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    api: API_BASE_URL,
    stripe: process.env.STRIPE_SECRET_KEY ? 'configured' : 'missing',
    pterodactyl: process.env.PTERODACTYL_API_URL,
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Debug endpoint to test Stripe connection
app.get('/debug/stripe/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    console.log('🔍 Debug request for session:', sessionId);
    
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
        currency: session.currency
      }
    });
  } catch (error) {
    console.error('❌ Debug session error:', error.message);
    res.status(500).json({ 
      error: error.message,
      type: error.type 
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('🚨 Global error handler:', err);
  res.status(500).json({
    error: 'Internal server error',
    code: 'INTERNAL_SERVER_ERROR',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// 404 handler
app.use((req, res) => {
  console.log(`❌ 404 - Route not found: ${req.method} ${req.path}`);
  res.status(404).json({
    error: 'Route not found',
    code: 'NOT_FOUND',
    path: req.path,
    method: req.method
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
  console.log('==========================================');
});
