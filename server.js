require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// Enhanced CORS configuration
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Pterodactyl Server Creation Function
const createPterodactylServer = async (customerEmail, serverConfig) => {
  try {
    console.log(`Starting server creation for ${customerEmail}`);

    // 1. Find or create user in Pterodactyl
    let user;
    try {
      const userResponse = await axios.get(
        `${process.env.PTERODACTYL_URL}/api/application/users?filter[email]=${encodeURIComponent(customerEmail)}`,
        {
          headers: { 
            Authorization: `Bearer ${process.env.PTERODACTYL_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (userResponse.data.data.length === 0) {
        // Create new user if doesn't exist
        const newUser = await axios.post(
          `${process.env.PTERODACTYL_URL}/api/application/users`,
          {
            email: customerEmail,
            username: customerEmail.split('@')[0],
            first_name: 'Minecraft',
            last_name: 'Player',
            password: Math.random().toString(36).slice(2) // Random password
          },
          {
            headers: { Authorization: `Bearer ${process.env.PTERODACTYL_KEY}` }
          }
        );
        user = newUser.data.attributes;
      } else {
        user = userResponse.data.data[0].attributes;
      }
    } catch (error) {
      console.error('User lookup/creation failed:', error.response?.data || error.message);
      throw new Error('Failed to setup user account');
    }

    // 2. Get server resources
    const [egg, allocations] = await Promise.all([
      axios.get(`${process.env.PTERODACTYL_URL}/api/application/nests/1/eggs/3?include=variables`, {
        headers: { Authorization: `Bearer ${process.env.PTERODACTYL_KEY}` }
      }),
      axios.get(`${process.env.PTERODACTYL_URL}/api/application/nodes/1/allocations`, {
        headers: { Authorization: `Bearer ${process.env.PTERODACTYL_KEY}` }
      })
    ]);

    // 3. Find free allocation
    const freeAllocation = allocations.data.data.find(a => !a.attributes.assigned);
    if (!freeAllocation) {
      throw new Error('No server capacity available');
    }

    // 4. Prepare environment variables
    const environment = {
      BUNGEE_VERSION: 'latest',
      SERVER_JARFILE: 'server.jar',
      EULA: 'TRUE',
      VERSION: serverConfig.minecraftVersion || 'latest',
      MAX_PLAYERS: serverConfig.maxPlayers || 20,
      VIEW_DISTANCE: serverConfig.viewDistance || 10,
      ENABLE_WHITELIST: serverConfig.enableWhitelist ? 'TRUE' : 'FALSE',
      ENABLE_PVP: serverConfig.enablePvp ? 'TRUE' : 'FALSE'
    };

    // 5. Create the server
    const serverResponse = await axios.post(
      `${process.env.PTERODACTYL_URL}/api/application/servers`,
      {
        name: serverConfig.serverName,
        user: user.id,
        egg: egg.data.attributes.id,
        docker_image: egg.data.attributes.docker_image,
        startup: `java -Xms128M -Xmx${serverConfig.totalRam * 1024}M -jar {{SERVER_JARFILE}}`,
        environment,
        limits: {
          memory: serverConfig.totalRam * 1024,
          disk: serverConfig.diskSpace || 5120, // 5GB default
          cpu: serverConfig.cpuLimit || 100,
          io: 500,
          threads: null,
          swap: 0
        },
        feature_limits: {
          databases: 0,
          allocations: 1,
          backups: 0
        },
        allocation: {
          default: freeAllocation.attributes.id
        },
        deploy: {
          locations: [1],
          dedicated_ip: false,
          port_range: []
        }
      },
      { 
        headers: { Authorization: `Bearer ${process.env.PTERODACTYL_KEY}` },
        maxBodyLength: Infinity
      }
    );

    // 6. Start the server
    await axios.post(
      `${process.env.PTERODACTYL_URL}/api/application/servers/${serverResponse.data.attributes.id}/power`,
      { signal: 'start' },
      { headers: { Authorization: `Bearer ${process.env.PTERODACTYL_KEY}` }
    );

    return {
      serverId: serverResponse.data.attributes.id,
      identifier: serverResponse.data.attributes.identifier,
      ip: freeAllocation.attributes.ip,
      port: freeAllocation.attributes.port,
      connectionDetails: `${freeAllocation.attributes.ip}:${freeAllocation.attributes.port}`
    };

  } catch (error) {
    console.error('Server creation failed:', {
      error: error.response?.data || error.message,
      stack: error.stack
    });
    throw new Error('Failed to create game server');
  }
};

// Stripe Checkout Endpoint
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { serverConfig } = req.body;

    // Validate required fields
    if (!serverConfig?.serverName || !serverConfig?.totalCost) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        details: 'serverName and totalCost are required'
      });
    }

    // Create Stripe session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{
        price: process.env.STRIPE_PRICE_ID, // Your Stripe price ID
        quantity: 1,
      }],
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/cancel`,
      metadata: serverConfig,
      customer_email: serverConfig.customerEmail,
      subscription_data: {
        trial_period_days: serverConfig.trialDays || 0
      }
    });

    if (!session.url) {
      throw new Error('Stripe did not provide checkout URL');
    }

    res.json({
      success: true,
      sessionId: session.id,
      checkoutUrl: session.url
    });

  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ 
      error: 'Failed to create payment session',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Webhook Handler
app.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook verification failed:', err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        const session = event.data.object;
        console.log(`Payment completed for ${session.customer_email}`);

        // Create server only if payment succeeded
        if (session.payment_status === 'paid') {
          const server = await createPterodactylServer(
            session.customer_email,
            session.metadata
          );

          // Update Stripe metadata with server details
          await stripe.checkout.sessions.update(session.id, {
            metadata: {
              ...session.metadata,
              serverId: server.serverId,
              ip: server.ip,
              port: server.port,
              status: 'active',
              connectionDetails: server.connectionDetails
            }
          });

          console.log(`Server created: ${server.connectionDetails}`);
        }
        break;

      case 'invoice.payment_succeeded':
        // Handle recurring payments
        console.log(`Recurring payment for ${event.data.object.customer_email}`);
        break;

      case 'invoice.payment_failed':
        // Handle payment failures
        console.error(`Payment failed for ${event.data.object.customer_email}`);
        break;
    }
  } catch (error) {
    console.error('Webhook processing error:', error);
    // Update Stripe metadata with error if possible
    if (event.type === 'checkout.session.completed') {
      await stripe.checkout.sessions.update(event.data.object.id, {
        metadata: {
          ...event.data.object.metadata,
          error: error.message,
          status: 'failed'
        }
      });
    }
  }

  res.json({ received: true });
});

// Server Status Endpoint
app.get('/server-status/:sessionId', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
    
    if (!session.metadata.status) {
      return res.json({ status: 'processing' });
    }

    if (session.metadata.status === 'failed') {
      return res.status(500).json({
        status: 'failed',
        error: session.metadata.error || 'Server creation failed'
      });
    }

    res.json({
      status: session.metadata.status,
      ip: session.metadata.ip,
      port: session.metadata.port,
      connectionDetails: session.metadata.connectionDetails,
      serverName: session.metadata.serverName
    });

  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({ 
      error: 'Failed to check server status',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Stripe webhook URL: ${process.env.FRONTEND_URL}/webhook`);
  console.log(`Pterodactyl URL: ${process.env.PTERODACTYL_URL}`);
});
