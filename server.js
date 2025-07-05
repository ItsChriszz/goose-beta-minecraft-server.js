const CreateUser = async (email) => {
  // Enhanced validation
  if (!email || typeof email !== 'string') {
    throw new Error('Email must be a valid string');
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    throw new Error('Invalid email format');
  }

  // Normalize email
  email = email.trim().toLowerCase();

  try {
    console.log(`[User Creation] Starting process for email: ${email}`);
    
    // 1. First check if user exists
    console.log('[User Creation] Checking for existing user...');
    const searchResponse = await axios.get(
      `${PTERODACTYL_BASE}/api/application/users?filter[email]=${encodeURIComponent(email)}`, 
      {
        headers: {
          'Authorization': `Bearer ${PTERODACTYL_API_KEY}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );
    
    // Debug API response
    console.log('[User Creation] Search response:', {
      status: searchResponse.status,
      data: searchResponse.data
    });

    if (searchResponse.data.data.length > 0) {
      const existingUser = searchResponse.data.data[0].attributes;
      console.log('[User Creation] Existing user found:', existingUser.username);
      return {
        success: true,
        userId: existingUser.id.toString(), // Ensure string ID
        username: existingUser.username,
        email: existingUser.email,
        existing: true
      };
    }
    
    // 2. Generate username
    const username = generateUsernameFromEmail(email);
    console.log('[User Creation] Generated username:', username);
    
    // 3. Prepare user data
    const userData = {
      email: email,
      username: username,
      first_name: username.split('.')[0] || username,
      last_name: 'User',
      password: generateRandomPassword(16),
      root_admin: false,
      language: 'en'
    };
    
    console.log('[User Creation] User creation payload:', userData);
    
    // 4. Create user
    const createResponse = await axios.post(
      `${PTERODACTYL_BASE}/api/application/users`, 
      userData, 
      {
        headers: {
          'Authorization': `Bearer ${PTERODACTYL_API_KEY}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    console.log('[User Creation] Create response:', {
      status: createResponse.status,
      data: createResponse.data
    });

    if (!createResponse.data.attributes) {
      throw new Error('Invalid response format from Pterodactyl API');
    }
    
    console.log('[User Creation] User created successfully:', createResponse.data.attributes.username);
    return {
      success: true,
      userId: createResponse.data.attributes.id.toString(),
      username: createResponse.data.attributes.username,
      email: createResponse.data.attributes.email,
      existing: false
    };
    
  } catch (error) {
    console.error('[User Creation] Error:', {
      message: error.message,
      response: {
        status: error.response?.status,
        data: error.response?.data,
        headers: error.response?.headers
      },
      stack: error.stack
    });
    
    // Handle specific error cases
    if (error.response) {
      // 422 Validation errors
      if (error.response.status === 422) {
        const errors = error.response.data?.errors || [];
        const errorDetails = errors.map(e => ({
          field: e.source?.pointer,
          detail: e.detail
        }));
        
        console.error('[User Creation] Validation errors:', errorDetails);
        
        // Handle email already exists (race condition)
        if (errors.some(e => 
          e.detail.includes('already exists') && 
          e.source?.pointer === '/data/attributes/email'
        )) {
          console.log('[User Creation] Race condition detected - retrying search');
          try {
            const retryResponse = await axios.get(
              `${PTERODACTYL_BASE}/api/application/users?filter[email]=${encodeURIComponent(email)}`,
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
                existing: true
              };
            }
          } catch (retryError) {
            console.error('[User Creation] Retry failed:', retryError.message);
          }
        }
        
        throw new Error(`Validation failed: ${errorDetails.map(e => e.detail).join(', ')}`);
      }
      
      // 403 Forbidden (likely API key issue)
      if (error.response.status === 403) {
        throw new Error('API authentication failed - check your Pterodactyl API key permissions');
      }
    }
    
    throw new Error(`User creation failed: ${error.message}`);
  }
};

// Helper function with improved username generation
function generateUsernameFromEmail(email) {
  // Extract the first part of the email
  let username = email.split('@')[0];
  
  // Remove all special characters
  username = username.replace(/[^a-zA-Z0-9]/g, '');
  
  // Convert to lowercase
  username = username.toLowerCase();
  
  // Ensure minimum length of 3 characters
  if (username.length < 3) {
    username += 'user';
  }
  
  // Add random numbers if too short
  if (username.length < 6) {
    username += Math.floor(Math.random() * 1000);
  }
  
  // Trim to max 16 characters (Pterodactyl limit)
  return username.slice(0, 16);
}

// More secure password generation
function generateRandomPassword(length = 16) {
  const crypto = require('crypto');
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  const randomBytes = crypto.randomBytes(length);
  let password = '';
  
  for (let i = 0; i < length; i++) {
    password += chars[randomBytes[i] % chars.length];
  }
  
  return password;
}
