// server.js - Simplified version using PaymentHandler
const express = require('express');
const cors = require('cors');
const PaymentHandler = require('./paymentHandler');
const { createPterodactylServer, generateServerCredentials } = require('./serverManager'); // Your existing server creation logic

const app = express();
const paymentHandler = new PaymentHandler();

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Create checkout session - SIMPLIFIED
app.post('/create-checkout-session', async (req, res) => {
  try {
    console.log('🦆 GOOSE HOSTING - CHECKOUT SESSION REQUEST');
    console.log('============================================');
    console.log('📋 Request body:', req.body);

    const result = await paymentHandler.createCheckoutSession(req.body);
    
    console.log('✅ Checkout session created successfully');
    console.log('💳 Session ID:', result.sessionId);
    console.log('💰 Final Price:', paymentHandler.formatPrice(result.pricing.finalPrice));
    console.log('============================================');

    res.json({
      sessionId: result.sessionId,
      url: result.url
    });

  } catch (error) {
    console.error('❌ Error creating checkout session:', error);
    res.status(500).json({
      error: error.message || 'Failed to create checkout session'
    });
  }
});

// Webhook handler - SIMPLIFIED
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  try {
    // Validate webhook
    const event = paymentHandler.validateWebhook(req.body, sig, webhookSecret);
    
    // Process the event
    const result = await paymentHandler.processWebhookEvent(event);
    
    // Handle server creation if needed
    if (result.action === 'server_creation') {
      try {
        console.log('🚀 Creating Pterodactyl server...');
        const serverDetails = await createPterodactylServer(result.session);
        
        // Update Stripe session with server details
        await paymentHandler.updateSessionWithServerDetails(result.session.id, serverDetails);
        
        console.log('✅ Server created and session updated successfully');
      } catch (serverError) {
        console.error('❌ Server creation failed:', serverError);
        // You might want to handle this differently - maybe retry later
      }
    }

    res.json({ received: true, processed: result.processed });

  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Get session details for success page
app.get('/session-details/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    console.log('📋 Fetching session details for:', sessionId);
    
    // Note: In a real app, you might want to cache this or store in a database
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Extract server information from metadata
    const serverInfo = {
      sessionId: session.id,
      customerEmail: session.customer_details?.email || session.customer_email,
      amountTotal: session.amount_total,
      paymentStatus: session.payment_status,
      createdAt: new Date(session.created * 1000).toISOString(),
      metadata: session.metadata
    };

    console.log('✅ Session details retrieved:', {
      sessionId: serverInfo.sessionId,
      paymentStatus: serverInfo.paymentStatus,
      serverStatus: serverInfo.metadata?.serverStatus
    });

    res.json(serverInfo);

  } catch (error) {
    console.error('❌ Error fetching session details:', error);
    res.status(500).json({ error: 'Failed to fetch session details' });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('🚨 Unhandled error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log('🦆 GOOSE HOSTING API SERVER');
  console.log('============================');
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:3000'}`);
  console.log(`💳 Stripe configured: ${process.env.STRIPE_SECRET_KEY ? '✅' : '❌'}`);
  console.log(`🪝 Webhook configured: ${process.env.STRIPE_WEBHOOK_SECRET ? '✅' : '❌'}`);
  console.log('============================');
});

module.exports = app;
