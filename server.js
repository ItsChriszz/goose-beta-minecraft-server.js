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
  origin: process.env.FRONTEND_URL,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization',
    'X-Requested-With',
    'Accept'
  ],
  credentials: true,
  optionsSuccessStatus: 200 // For legacy browser support
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

// Pterodactyl API wrapper
const pterodactylRequest = async (method, endpoint, data = null) => {
  try {
    const response = await axios({
      method,
      url: `${process.env.PTERODACTYL_API_URL}${endpoint}`,
      headers: {
        'Authorization': `Bearer ${process.env.PTERODACTYL_API_KEY}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      data
    });
    return response.data;
  } catch (error) {
    console.error('Pterodactyl API Error:', {
      endpoint,
      status: error.response?.status,
      data: error.response?.data
    });
    throw error;
  }
};

// Server creation logic
const createMinecraftServer = async (session) => {
  const { customer_details, metadata } = session;
  const email = customer_details?.email || metadata?.customerEmail;
  
  if (!email) {
    throw new Error('No customer email available');
  }

  // 1. Find or create user
  let user;
  try {
    const users = await pterodactylRequest('get', '/users');
    const existingUser = users.data.find(u => u.attributes.email === email);
    
    if (existingUser) {
      user = {
        id: existingUser.attributes.id,
        username: existingUser.attributes.username,
        isNew: false
      };
    } else {
      const { username, password } = generateCredentials();
      const newUser = await pterodactylRequest('post', '/users', {
        email,
        username,
        first_name: 'Minecraft',
        last_name: 'Player',
        password
      });
      user = {
        id: newUser.attributes.id,
        username,
        password,
        isNew: true
      };
    }
  } catch (error) {
    console.error('User creation failed:', error);
    throw new Error('Failed to setup user account');
  }

  // 2. Get server resources
  const [eggs, nodes] = await Promise.all([
    pterodactylRequest('get', '/nests/1/eggs'),
    pterodactylRequest('get', '/nodes')
  ]);

  const minecraftEgg = eggs.data.find(e => 
    e.attributes.name.toLowerCase().includes('minecraft')
  );
  const node = nodes.data[0];
  const allocations = await pterodactylRequest(
    'get', 
    `/nodes/${node.attributes.id}/allocations`
  );
  const allocation = allocations.data.find(a => !a.attributes.assigned);

  if (!minecraftEgg || !allocation) {
    throw new Error('Server resources unavailable');
  }

  // 3. Create server
  const serverConfig = {
    name: metadata.serverName || `mc-${Date.now()}`,
    user: user.id,
    egg: minecraftEgg.attributes.id,
    docker_image: minecraftEgg.attributes.docker_image,
    startup: minecraftEgg.attributes.startup,
    environment: {
      SERVER_JARFILE: 'server.jar',
      VERSION: metadata.minecraftVersion || 'latest',
      SERVER_MEMORY: (parseInt(metadata.totalRam) || 4) * 1024
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

  const server = await pterodactylRequest('post', '/servers', serverConfig);
  
  return {
    serverId: server.attributes.id,
    identifier: server.attributes.identifier,
    name: server.attributes.name,
    ip: allocation.attributes.ip,
    port: allocation.attributes.port,
    username: user.username,
    password: user.isNew ? user.password : undefined,
    panelUrl: process.env.PTERODACTYL_API_URL.replace('/api/application', '')
  };
};

// API Endpoints
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { serverConfig } = req.body;
    
    if (!serverConfig?.serverName) {
      return res.status(400).json({ 
        error: 'Server name is required',
        code: 'MISSING_SERVER_NAME'
      });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Minecraft Server - ${serverConfig.serverName}`,
            description: serverConfig.serverType || 'Minecraft Server'
          },
          unit_amount: 1000, // $10.00
          recurring: { interval: 'month' }
        },
        quantity: 1,
      }],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}`,
      metadata: {
        ...serverConfig,
        customerEmail: serverConfig.customerEmail || '',
        totalRam: String(serverConfig.totalRam || 4),
        minecraftVersion: serverConfig.minecraftVersion || 'latest',
        serverType: serverConfig.serverType || 'paper'
      }
    });

    res.json({ 
      sessionId: session.id,
      url: session.url 
    });

  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ 
      error: error.message,
      code: 'CHECKOUT_ERROR'
    });
  }
});

app.get('/server-details/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    if (!sessionId.startsWith('cs_')) {
      return res.status(400).json({ 
        error: 'Invalid session ID format',
        code: 'INVALID_SESSION_ID'
      });
    }

    // Retrieve session with expanded customer details
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['customer']
    });

    if (!session) {
      return res.status(404).json({ 
        error: 'Session not found',
        code: 'SESSION_NOT_FOUND'
      });
    }

    // Handle payment status
    if (session.payment_status !== 'paid') {
      return res.status(402).json({ 
        status: 'payment_required',
        paymentStatus: session.payment_status,
        sessionId: session.id
      });
    }

    // Check if server already created
    if (session.metadata.serverCreated === 'true') {
      return res.json({
        status: 'ready',
        server: {
          name: session.metadata.serverName,
          ip: session.metadata.serverIp,
          port: session.metadata.serverPort,
          panelUrl: process.env.PTERODACTYL_API_URL.replace('/api/application', '')
        }
      });
    }

    // Create server since payment is complete
    const serverDetails = await createMinecraftServer(session);
    
    // Update session metadata
    await stripe.checkout.sessions.update(sessionId, {
      metadata: {
        ...session.metadata,
        serverCreated: 'true',
        serverIp: serverDetails.ip,
        serverPort: serverDetails.port,
        serverId: serverDetails.serverId
      }
    });

    res.json({
      status: 'ready',
      server: serverDetails
    });

  } catch (error) {
    console.error('Server details error:', error);
    
    if (error.type === 'StripeInvalidRequestError') {
      return res.status(404).json({ 
        error: 'Session not found in Stripe',
        code: 'STRIPE_SESSION_NOT_FOUND'
      });
    }
    
    res.status(500).json({ 
      error: error.message,
      code: 'SERVER_DETAILS_ERROR'
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
    console.error('Webhook verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // Log event but don't process - we handle creation via /server-details
  console.log(`Stripe event: ${event.type}`);
  res.json({ received: true });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    api: API_BASE_URL,
    stripe: process.env.STRIPE_SECRET_KEY ? 'configured' : 'missing',
    pterodactyl: process.env.PTERODACTYL_API_URL,
    timestamp: new Date().toISOString()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Global error handler:', err);
  res.status(500).json({
    error: 'Internal server error',
    code: 'INTERNAL_SERVER_ERROR'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on ${API_BASE_URL}`);
  console.log(`🔗 CORS enabled for: ${process.env.FRONTEND_URL}`);
  console.log(`💳 Stripe mode: ${process.env.STRIPE_SECRET_KEY?.startsWith('sk_test') ? 'TEST' : 'LIVE'}`);
});
