// server.js - Complete implementation with fixed user assignment and debugging
const express = require('express');
const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const crypto = require('crypto');

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Add CORS if needed
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

// Validate environment variables
const validateEnvVars = () => {
  const requiredVars = [
    'STRIPE_SECRET_KEY',
    'PTERODACTYL_BASE',
    'PTERODACTYL_API_KEY',
    'PTERODACTYL_NODE_ID',
    'PTERODACTYL_EGG_ID'
  ];
  
  const missingVars = requiredVars.filter(varName => !process.env[varName]);
  if (missingVars.length > 0) {
    console.error(`❌ Missing required environment variables: ${missingVars.join(', ')}`);
    throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
  }
  
  console.log('✅ All required environment variables are set');
};

// Run validation
try {
  validateEnvVars();
} catch (error) {
  console.error('🚨 Environment validation failed:', error.message);
  process.exit(1);
}

// Pterodactyl configuration
const PTERODACTYL_BASE = process.env.PTERODACTYL_BASE;
const PTERODACTYL_API_KEY = process.env.PTERODACTYL_API_KEY;
const MaxServersPerNode = parseInt(process.env.MaxServersPerNode) || 50;
const nodeId = process.env.PTERODACTYL_NODE_ID;

// Helper function to make authenticated requests to Pterodactyl
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
  
  try {
    const response = await axios(config);
    return response;
  } catch (error) {
    console.error(`❌ Pterodactyl API Error [${method} ${endpoint}]:`, {
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

// Helper function to generate username from email
function generateUsernameFromEmail(email) {
  const baseUsername = email.split('@')[0]
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase()
    .slice(0, 12);
  
  const randomSuffix = Math.floor(Math.random() * 9999).toString().padStart(4, '0');
  return `${baseUsername}${randomSuffix}`;
}

// Improved CreateUser function with extensive logging
const CreateUser = async (email) => {
  const logPrefix = `[CreateUser-${Date.now()}]`;
  console.log(`${logPrefix} 🔍 Starting user creation for: ${email}`);
  
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    console.error(`${logPrefix} ❌ Invalid email: ${email}`);
    throw new Error('Invalid email address provided');
  }

  try {
    // STEP 1: Search for existing user
    console.log(`${logPrefix} 🔍 Searching for existing user...`);
    const searchResponse = await pterodactylRequest(
      'GET', 
      `/users?filter[email]=${encodeURIComponent(email)}`
    );
    
    console.log(`${logPrefix} 📊 Search response:`, {
      status: searchResponse.status,
      userCount: searchResponse.data.data.length,
      users: searchResponse.data.data.map(u => ({
        id: u.attributes.id,
        email: u.attributes.email,
        username: u.attributes.username
      }))
    });
    
    if (searchResponse.data.data.length > 0) {
      const existingUser = searchResponse.data.data[0].attributes;
      console.log(`${logPrefix} ✅ Found existing user:`, {
        id: existingUser.id,
        username: existingUser.username,
        email: existingUser.email
      });
      return {
        success: true,
        userId: existingUser.id,
        username: existingUser.username,
        email: existingUser.email,
        existing: true
      };
    }
    
    // STEP 2: Create new user
    console.log(`${logPrefix} 🆕 No existing user found, creating new user...`);
    
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
    
    console.log(`${logPrefix} 📤 Creating user with data:`, {
      ...userData,
      password: '[HIDDEN]'
    });
    
    const response = await pterodactylRequest('POST', '/users', userData);
    
    console.log(`${logPrefix} ✅ User created successfully:`, {
      id: response.data.attributes.id,
      username: response.data.attributes.username,
      email: response.data.attributes.email
    });
    
    return {
      success: true,
      userId: response.data.attributes.id,
      username: response.data.attributes.username,
      email: response.data.attributes.email,
      password: password,
      existing: false
    };
    
  } catch (error) {
    console.error(`${logPrefix} ❌ Error in CreateUser:`, {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    
    // Handle 422 validation errors
    if (error.response?.status === 422) {
      const errors = error.response?.data?.errors || [];
      console.log(`${logPrefix} 📋 Validation errors:`, errors);
      
      // Check for race condition (user already exists)
      if (errors.some(e => e.detail?.includes('already exists') || e.detail?.includes('taken'))) {
        console.log(`${logPrefix} 🔄 Possible race condition, searching again...`);
        try {
          const retrySearch = await pterodactylRequest(
            'GET',
            `/users?filter[email]=${encodeURIComponent(email)}`
          );
          
          if (retrySearch.data.data.length > 0) {
            const user = retrySearch.data.data[0].attributes;
            console.log(`${logPrefix} ✅ Found user on retry:`, user.username);
            return {
              success: true,
              userId: user.id,
              username: user.username,
              email: user.email,
              existing: true
            };
          }
        } catch (retryError) {
          console.error(`${logPrefix} ❌ Retry search failed:`, retryError.message);
        }
      }
    }
    
    throw new Error(`Failed to create/find user: ${error.message}`);
  }
};

// Fixed server limit checking
const checkServerLimits = async () => {
  try {
    console.log(`🔄 Checking server limits on node ${nodeId}`);
    
    const response = await pterodactylRequest('GET', `/nodes/${nodeId}/servers`);
    
    const currentServers = response.data.data.length;
    console.log(`📊 Current servers: ${currentServers}/${MaxServersPerNode}`);
    
    if (currentServers >= MaxServersPerNode) {
      throw new Error(`Server limit reached (${currentServers}/${MaxServersPerNode})`);
    }
    
    return { currentServers, maxServers: MaxServersPerNode };
  } catch (err) {
    console.error('❌ Server limit check failed:', err.message);
    throw new Error(`Server limit validation failed: ${err.message}`);
  }
};

// Get available allocation
const getAvailableAllocation = async (nodeId) => {
  try {
    console.log(`🔍 Looking for available allocation on node ${nodeId}`);
    
    const response = await pterodactylRequest('GET', `/nodes/${nodeId}/allocations`);
    
    const availableAllocations = response.data.data.filter(a => !a.attributes.assigned);
    
    if (availableAllocations.length === 0) {
      throw new Error('No available server ports/allocations on this node');
    }
    
    const allocation = availableAllocations[0];
    console.log(`✅ Found available allocation: ${allocation.attributes.ip}:${allocation.attributes.port}`);
    
    return allocation;
  } catch (error) {
    console.error('❌ Failed to get allocation:', error.message);
    throw error;
  }
};

// Main server creation function with proper user assignment
async function createPterodactylServer(session) {
  const sessionId = session.id || 'unknown';
  const logPrefix = `[Server-${sessionId}]`;
  
  try {
    console.log(`${logPrefix} 🚀 Starting server creation process`);
    
    // Validate session
    if (!session || typeof session !== 'object') {
      throw new Error('Invalid session data');
    }
    
    // Get customer email
    const customerEmail = session.customer_details?.email || 
                        session.customer_email || 
                        session.metadata?.customerEmail ||
                        session.customer?.email;
    
    if (!customerEmail || !customerEmail.includes('@')) {
      throw new Error('Valid customer email is required');
    }
    
    console.log(`${logPrefix} 📧 Creating server for: ${customerEmail}`);
    
    // STEP 1: Check server limits first
    await checkServerLimits();
    
    // STEP 2: Create or find user
    const userResult = await CreateUser(customerEmail);
    console.log(`${logPrefix} 👤 User creation result:`, {
      success: userResult.success,
      userId: userResult.userId,
      username: userResult.username,
      email: userResult.email,
      existing: userResult.existing,
      password: userResult.password ? '[HIDDEN]' : 'NO_PASSWORD'
    });
    
    // CRITICAL: Verify the user ID is not 1 (admin)
    if (userResult.userId === 1) {
      console.error(`${logPrefix} ⚠️ WARNING: User ID is 1 (admin)! This should not happen.`);
      console.error(`${logPrefix} 📧 Email used for user creation: ${customerEmail}`);
      throw new Error('User creation returned admin user ID - this indicates a problem');
    }
    
    // STEP 3: Get available allocation
    const allocation = await getAvailableAllocation(nodeId);
    
    // STEP 4: Prepare server configuration
    const serverName = session.metadata?.serverName || `Server-${Date.now()}`;
    const totalRam = parseInt(session.metadata?.totalRam) || 4;
    const maxPlayers = parseInt(session.metadata?.maxPlayers) || 20;
    const minecraftVersion = session.metadata?.minecraftVersion || 'latest';
    
    // CRITICAL: Create server with proper user assignment
    const serverData = {
      name: serverName,
      user: parseInt(userResult.userId), // Ensure it's an integer
      egg: parseInt(process.env.PTERODACTYL_EGG_ID),
      docker_image: session.metadata?.dockerImage || 'ghcr.io/pterodactyl/yolks:java_17',
      startup: session.metadata?.startup || 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}',
      environment: {
        SERVER_JARFILE: 'server.jar',
        MINECRAFT_VERSION: minecraftVersion,
        EULA: 'true',
        ...session.metadata?.environment
      },
      limits: {
        memory: totalRam * 1024,
        swap: 0,
        disk: totalRam * 2000,
        io: 500,
        cpu: 0
      },
      feature_limits: {
        databases: 2,
        allocations: 1,
        backups: 5
      },
      allocation: {
        default: parseInt(allocation.attributes.id)
      }
    };
    
    console.log(`${logPrefix} 🛠️ Creating server with owner ID: ${serverData.user}`);
    console.log(`${logPrefix} 📋 Server config:`, {
      name: serverData.name,
      user: serverData.user,
      egg: serverData.egg,
      allocation: serverData.allocation.default
    });
    
    // STEP 5: Create the server
    const response = await pterodactylRequest('POST', '/servers', serverData);
    
    const serverId = response.data.attributes.id;
    const serverUuid = response.data.attributes.uuid;
    const serverOwner = response.data.attributes.user;
    const serverAddress = `${allocation.attributes.ip}:${allocation.attributes.port}`;
    
    console.log(`${logPrefix} 🎉 Server created:`, {
      id: serverId,
      uuid: serverUuid,
      expectedOwner: userResult.userId,
      actualOwner: serverOwner,
      ownershipCorrect: serverOwner === userResult.userId
    });
    
    // STEP 6: Verify and fix ownership if needed
    if (serverOwner !== userResult.userId) {
      console.log(`${logPrefix} ⚠️ Server owner mismatch! Attempting to fix...`);
      
      try {
        // Method 1: Try to update server owner
        await pterodactylRequest('PATCH', `/servers/${serverId}/details`, {
          user: parseInt(userResult.userId)
        });
        console.log(`${logPrefix} ✅ Server ownership transferred via PATCH`);
      } catch (patchError) {
        console.log(`${logPrefix} ❌ PATCH transfer failed, trying subuser assignment...`);
        
        // Method 2: Add user as subuser with full permissions
        try {
          await pterodactylRequest('POST', `/servers/${serverId}/users`, {
            email: customerEmail,
            permissions: [
              "control.console",
              "control.start",
              "control.stop", 
              "control.restart",
              "control.kill",
              "user.create",
              "user.read",
              "user.update",
              "user.delete",
              "file.create",
              "file.read",
              "file.update",
              "file.delete",
              "file.archive",
              "file.sftp",
              "backup.create",
              "backup.read",
              "backup.delete",
              "backup.download",
              "allocation.read",
              "allocation.create",
              "allocation.update",
              "allocation.delete",
              "startup.read",
              "startup.update",
              "database.create",
              "database.read",
              "database.update",
              "database.delete",
              "database.view_password",
              "schedule.create",
              "schedule.read",
              "schedule.update",
              "schedule.delete",
              "settings.rename",
              "settings.reinstall"
            ]
          });
          console.log(`${logPrefix} ✅ User added as subuser with full permissions`);
        } catch (subuserError) {
          console.error(`${logPrefix} ❌ Subuser assignment also failed:`, subuserError.message);
          // Continue anyway - server is created
        }
      }
    }
    
    // STEP 7: Generate credentials
    const credentials = {
      serverUsername: userResult.username,
      serverPassword: userResult.password || 'UseExistingPassword',
      ftpHost: allocation.attributes.ip,
      ftpPort: '21',
      ftpUsername: userResult.username,
      ftpPassword: userResult.password || 'UseExistingPassword'
    };
    
    // STEP 8: Update Stripe session with all details
    if (session.id) {
      try {
        const updatedMetadata = {
          ...session.metadata,
          serverId: serverId.toString(),
          serverUuid: serverUuid,
          serverAddress: serverAddress,
          pterodactylUserId: userResult.userId.toString(),
          pterodactylUsername: userResult.username,
          ownerEmail: customerEmail,
          userStatus: userResult.existing ? 'existing' : 'new',
          serverStatus: 'created',
          createdAt: new Date().toISOString(),
          panelUrl: `${PTERODACTYL_BASE.replace('/api', '')}/server/${serverUuid}`,
          ...credentials
        };
        
        console.log(`${logPrefix} 📝 Updating Stripe session with metadata:`, {
          sessionId: session.id,
          pterodactylUserId: updatedMetadata.pterodactylUserId,
          pterodactylUsername: updatedMetadata.pterodactylUsername,
          serverStatus: updatedMetadata.serverStatus
        });
        
        await stripe.checkout.sessions.update(session.id, {
          metadata: updatedMetadata
        });
        
        console.log(`${logPrefix} ✅ Stripe session updated successfully`);
        
        // Verify the update worked
        const verifySession = await stripe.checkout.sessions.retrieve(session.id);
        console.log(`${logPrefix} 🔍 Verification - Updated metadata contains:`, {
          pterodactylUserId: verifySession.metadata?.pterodactylUserId,
          pterodactylUsername: verifySession.metadata?.pterodactylUsername,
          serverStatus: verifySession.metadata?.serverStatus
        });
        
      } catch (stripeError) {
        console.error(`${logPrefix} ❌ Failed to update Stripe session:`, {
          error: stripeError.message,
          sessionId: session.id,
          userResult: userResult
        });
        // Don't fail the entire process for this
      }
    } else {
      console.error(`${logPrefix} ⚠️ No session ID provided - cannot update metadata`);
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
        existing: userResult.existing
      },
      credentials,
      ownership: {
        expected: userResult.userId,
        actual: serverOwner
      }
    };
    
  } catch (err) {
    console.error(`${logPrefix} ❌ Server creation failed:`, {
      message: err.message,
      stack: err.stack,
      response: err.response?.data
    });
    throw err;
  }
}

// Debug function to check server ownership
const debugServerOwnership = async (serverId) => {
  try {
    const response = await pterodactylRequest('GET', `/servers/${serverId}`);
    const server = response.data.attributes;
    
    console.log('🔍 Server ownership debug:', {
      serverId: serverId,
      serverName: server.name,
      ownerId: server.user,
      uuid: server.uuid
    });
    
    return response.data;
  } catch (error) {
    console.error('❌ Server ownership debug failed:', error.message);
    throw error;
  }
};

// === DEBUG ENDPOINTS ===

// 1. Environment Variables Check
app.get('/debug/env', (req, res) => {
  console.log('🔍 Environment variables check requested');
  
  const envCheck = {
    timestamp: new Date().toISOString(),
    environment: {
      NODE_ENV: process.env.NODE_ENV || 'not set',
      PTERODACTYL_BASE: process.env.PTERODACTYL_BASE || 'NOT SET',
      PTERODACTYL_API_KEY: process.env.PTERODACTYL_API_KEY ? 
        `${process.env.PTERODACTYL_API_KEY.substring(0, 15)}...` : 'NOT SET',
      PTERODACTYL_NODE_ID: process.env.PTERODACTYL_NODE_ID || 'NOT SET',
      PTERODACTYL_EGG_ID: process.env.PTERODACTYL_EGG_ID || 'NOT SET',
      MaxServersPerNode: process.env.MaxServersPerNode || 'NOT SET'
    },
    validation: {
      hasBase: !!process.env.PTERODACTYL_BASE,
      hasApiKey: !!process.env.PTERODACTYL_API_KEY,
      hasNodeId: !!process.env.PTERODACTYL_NODE_ID,
      hasEggId: !!process.env.PTERODACTYL_EGG_ID,
      baseEndsWithApi: process.env.PTERODACTYL_BASE?.endsWith('/api'),
      apiKeyStartsCorrect: process.env.PTERODACTYL_API_KEY?.startsWith('ptla_')
    }
  };
  
  res.json(envCheck);
});

// 2. Test User Creation
app.post('/debug/test-user-creation', async (req, res) => {
  const testEmail = req.body.email || `test-${Date.now()}@coolify-debug.com`;
  
  console.log(`🧪 Testing user creation for email: ${testEmail}`);
  
  try {
    const result = await CreateUser(testEmail);
    
    // Cleanup if we created a new user
    if (!result.existing) {
      try {
        await pterodactylRequest('DELETE', `/users/${result.userId}`);
        result.cleanedUp = true;
      } catch (cleanupError) {
        result.cleanupFailed = cleanupError.message;
      }
    }
    
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message,
      details: error.response?.data
    });
  }
});

// 3. Test Server Limits
app.get('/debug/test-server-limits', async (req, res) => {
  try {
    const result = await checkServerLimits();
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. Debug Server Ownership
app.get('/debug/server-ownership/:serverId', async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const result = await debugServerOwnership(serverId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 6. Debug: Manually trigger server creation for a session
app.post('/debug/create-server-for-session', async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    
    console.log(`🧪 Manually triggering server creation for session: ${sessionId}`);
    
    // Retrieve the session
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['customer']
    });
    
    console.log(`📋 Session before server creation:`, {
      id: session.id,
      email: session.customer_details?.email,
      metadata: session.metadata
    });
    
    // Create the server
    const result = await createPterodactylServer(session);
    
    // Retrieve the session again to see updated metadata
    const updatedSession = await stripe.checkout.sessions.retrieve(sessionId);
    
    console.log(`📋 Session after server creation:`, {
      id: updatedSession.id,
      metadata: updatedSession.metadata
    });
    
    res.json({
      success: true,
      serverResult: result,
      sessionMetadata: updatedSession.metadata
    });
    
  } catch (error) {
    console.error('❌ Manual server creation failed:', error.message);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      details: error.response?.data 
    });
  }
});

// 8. Debug: Check Pterodactyl users
app.get('/debug/pterodactyl-users', async (req, res) => {
  try {
    console.log('🔍 Fetching all Pterodactyl users...');
    
    const response = await pterodactylRequest('GET', '/users');
    const users = response.data.data.map(user => ({
      id: user.attributes.id,
      email: user.attributes.email,
      username: user.attributes.username,
      first_name: user.attributes.first_name,
      last_name: user.attributes.last_name,
      root_admin: user.attributes.root_admin,
      created_at: user.attributes.created_at
    }));
    
    console.log('📋 Found users:', users);
    
    res.json({
      success: true,
      userCount: users.length,
      users: users
    });
  } catch (error) {
    console.error('❌ Failed to fetch users:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 9. Debug: Search for specific user by email
app.post('/debug/search-user-by-email', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    console.log(`🔍 Searching for user with email: ${email}`);
    
    const searchUrl = `/users?filter[email]=${encodeURIComponent(email)}`;
    console.log(`🔗 Search URL: ${searchUrl}`);
    
    const response = await pterodactylRequest('GET', searchUrl);
    const users = response.data.data.map(user => ({
      id: user.attributes.id,
      email: user.attributes.email,
      username: user.attributes.username,
      root_admin: user.attributes.root_admin
    }));
    
    console.log(`📋 Search results for ${email}:`, users);
    
    res.json({
      success: true,
      searchEmail: email,
      userCount: users.length,
      users: users
    });
  } catch (error) {
    console.error('❌ User search failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Stripe webhook endpoint
app.post('/webhook/stripe', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  
  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    
    console.log('🔔 Received Stripe webhook:', event.type);
    console.log('📋 Event data keys:', Object.keys(event.data.object));
    
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      console.log('💳 Checkout session completed:', session.id);
      console.log('📧 Customer email from session:', session.customer_details?.email);
      console.log('📦 Session metadata:', JSON.stringify(session.metadata, null, 2));
      
      try {
        console.log('🚀 Starting server creation from webhook...');
        const serverResult = await createPterodactylServer(session);
        console.log('✅ Server creation successful from webhook:', {
          serverId: serverResult.serverId,
          userId: serverResult.user.id,
          username: serverResult.user.username
        });
      } catch (serverError) {
        console.error('❌ Server creation failed in webhook:', serverError.message);
        console.error('📋 Server error details:', serverError);
      }
    }
    
    if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object;
      console.log('💸 Payment succeeded for:', invoice.id);
      
      // Get the subscription to find the checkout session
      try {
        const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
        console.log('📋 Subscription metadata:', subscription.metadata);
        
        // If we have a session ID in subscription metadata, process it
        if (subscription.metadata?.sessionId) {
          const session = await stripe.checkout.sessions.retrieve(subscription.metadata.sessionId);
          console.log('🔄 Processing server creation from invoice webhook...');
          
          const serverResult = await createPterodactylServer(session);
          console.log('✅ Server creation successful from invoice:', {
            serverId: serverResult.serverId,
            userId: serverResult.user.id,
            username: serverResult.user.username
          });
        } else {
          console.log('⚠️ No session ID found in subscription metadata');
        }
      } catch (subError) {
        console.error('❌ Failed to process invoice webhook:', subError.message);
      }
    }
    
    res.json({ received: true });
  } catch (err) {
    console.error('❌ Webhook signature verification failed:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// Get session details endpoint with enhanced debugging
app.get('/session-details/:sessionId', async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    console.log(`🔍 Retrieving session details for: ${sessionId}`);
    
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['customer']
    });
    
    console.log(`📋 Session metadata:`, JSON.stringify(session.metadata, null, 2));
    console.log(`📧 Customer email sources:`, {
      customer_details_email: session.customer_details?.email,
      customer_email: session.customer?.email,
      metadata_email: session.metadata?.customerEmail || session.metadata?.ownerEmail
    });
    
    const sessionData = {
      id: session.id,
      customerEmail: session.customer_details?.email || session.customer?.email,
      amountTotal: session.amount_total,
      currency: session.currency,
      paymentStatus: session.payment_status,
      metadata: session.metadata || {},
      createdAt: new Date(session.created * 1000).toISOString()
    };
    
    console.log(`📤 Returning session data:`, JSON.stringify(sessionData, null, 2));
    res.json(sessionData);
  } catch (error) {
    console.error('❌ Failed to retrieve session:', error.message);
    res.status(500).json({ error: 'Failed to retrieve session details' });
  }
});

// Create checkout session endpoint
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { planId, serverName, email } = req.body;
    
    // Define your plans
    const plans = {
      basic: { price: 500, name: 'Basic Plan', ram: 2 }, // $5.00
      pro: { price: 1000, name: 'Pro Plan', ram: 4 },   // $10.00
      premium: { price: 2000, name: 'Premium Plan', ram: 8 } // $20.00
    };
    
    const plan = plans[planId];
    if (!plan) {
      return res.status(400).json({ error: 'Invalid plan' });
    }
    
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Minecraft Server - ${plan.name}`,
            description: `${plan.ram}GB RAM Minecraft Server`
          },
          unit_amount: plan.price,
          recurring: {
            interval: 'month'
          }
        },
        quantity: 1
      }],
      success_url: `${req.headers.origin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.origin}/`,
      customer_email: email,
      metadata: {
        planId: planId,
        serverName: serverName || `${email.split('@')[0]}-server`,
        totalRam: plan.ram.toString(),
        maxPlayers: '20',
        minecraftVersion: 'latest',
        serverType: 'paper',
        customerEmail: email
      }
    });
    
    res.json({ url: session.url });
  } catch (error) {
    console.error('❌ Failed to create checkout session:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log('🔧 Debug endpoints available:');
  console.log('  GET  /debug/env - Check environment variables');
  console.log('  POST /debug/test-user-creation - Test user creation');
  console.log('  GET  /debug/test-server-limits - Test server limits');
  console.log('  GET  /debug/server-ownership/:id - Debug server ownership');
  console.log('  POST /debug/create-server-for-session - Manually create server');
  console.log('  GET  /debug/pterodactyl-users - List all Pterodactyl users');
  console.log('  POST /debug/search-user-by-email - Search user by email');
  console.log('  GET  /health - Health check');
});

// Export for testing
module.exports = {
  app,
  createPterodactylServer,
  CreateUser,
  checkServerLimits,
  debugServerOwnership
};
