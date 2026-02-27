const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Configuration
const PORT = process.env.PORT || 8080;
const WS_PORT = process.env.WS_PORT || 8081;

// Data storage (in production, use a database)
const users = new Map();
const apps = new Map();
const comments = new Map();
const collaborators = new Map();
const sessions = new Map();

// HTTP Server for API endpoints
const server = http.createServer((req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Parse JSON body
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const data = body ? JSON.parse(body) : {};
    
    // Auth endpoints
    if (pathname === '/api/auth/signup' && req.method === 'POST') {
      handleSignup(data, res);
    } else if (pathname === '/api/auth/login' && req.method === 'POST') {
      handleLogin(data, res);
    } else if (pathname === '/api/apps' && req.method === 'GET') {
      handleGetApps(url.searchParams.get('user'), res);
    } else if (pathname === '/api/apps' && req.method === 'POST') {
      handleCreateApp(data, res);
    } else if (pathname.startsWith('/api/apps/') && req.method === 'GET') {
      const appId = pathname.split('/')[3];
      handleGetApp(appId, res);
    } else if (pathname.startsWith('/api/apps/') && req.method === 'DELETE') {
      const appId = pathname.split('/')[3];
      handleDeleteApp(appId, data.username, res);
    } else if (pathname.startsWith('/api/comments/') && req.method === 'GET') {
      const appId = pathname.split('/')[3];
      handleGetComments(appId, res);
    } else if (pathname.startsWith('/api/comments/') && req.method === 'POST') {
      const appId = pathname.split('/')[3];
      handlePostComment(appId, data, res);
    } else if (pathname.startsWith('/api/comments/') && req.method === 'PUT') {
      const commentId = pathname.split('/')[3];
      handleUpdateComment(commentId, data, res);
    } else if (pathname.startsWith('/api/comments/') && req.method === 'DELETE') {
      const commentId = pathname.split('/')[3];
      handleDeleteComment(commentId, data, res);
    } else if (pathname.startsWith('/api/collaborators/') && req.method === 'GET') {
      const appId = pathname.split('/')[3];
      handleGetCollaborators(appId, res);
    } else if (pathname.startsWith('/api/collaborators/') && req.method === 'POST') {
      const appId = pathname.split('/')[3];
      handleAddCollaborator(appId, data, res);
    } else if (pathname.startsWith('/api/collaborators/') && req.method === 'DELETE') {
      const appId = pathname.split('/')[3];
      const username = url.searchParams.get('username');
      handleRemoveCollaborator(appId, username, data, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });
});

// WebSocket Server
const wss = new WebSocket.Server({ port: WS_PORT });

// Store connected clients
const clients = new Map();

wss.on('connection', (ws, req) => {
  console.log('New WebSocket connection');
  
  let userId = null;
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      switch(data.type) {
        case 'auth':
          userId = data.userId;
          clients.set(userId, ws);
          ws.send(JSON.stringify({ type: 'auth', status: 'success' }));
          break;
          
        case 'subscribe':
          // Subscribe to app updates
          ws.appId = data.appId;
          ws.send(JSON.stringify({ type: 'subscribed', appId: data.appId }));
          break;
          
        case 'comment':
          broadcastToApp(data.appId, {
            type: 'new_comment',
            comment: data.comment
          });
          // Send email notification if enabled
          sendEmailNotification(data.appId, 'comment', data.comment);
          break;
          
        case 'collaborator_added':
          broadcastToApp(data.appId, {
            type: 'collaborator_added',
            username: data.username,
            role: data.role
          });
          sendEmailNotification(data.appId, 'collaborator', { username: data.username });
          break;
          
        case 'app_updated':
          broadcastToApp(data.appId, {
            type: 'app_updated',
            updates: data.updates
          });
          break;
          
        case 'file_uploaded':
          broadcastToApp(data.appId, {
            type: 'file_uploaded',
            filename: data.filename
          });
          break;
      }
    } catch (err) {
      console.error('WebSocket message error:', err);
    }
  });
  
  ws.on('close', () => {
    if (userId) {
      clients.delete(userId);
    }
    console.log('Client disconnected');
  });
  
  // Send initial connection success
  ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
});

function broadcastToApp(appId, message) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.appId === appId) {
      client.send(JSON.stringify(message));
    }
  });
}

function broadcastToUser(userId, message) {
  const client = clients.get(userId);
  if (client && client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify(message));
  }
}

// Email notification simulation
function sendEmailNotification(appId, type, data) {
  const app = apps.get(appId);
  if (!app) return;
  
  // Get app owner
  const owner = users.get(app.owner);
  if (owner && owner.emailNotifications) {
    console.log(`[EMAIL] To: ${owner.email} - ${type} notification for app "${app.name}"`);
    console.log(`         Data:`, data);
  }
  
  // Notify collaborators
  const appCollaborators = collaborators.get(appId) || [];
  appCollaborators.forEach(collab => {
    const user = users.get(collab.username);
    if (user && user.emailNotifications) {
      console.log(`[EMAIL] To: ${user.email} - ${type} notification for app "${app.name}"`);
    }
  });
}

// HTTP Handlers
function handleSignup(data, res) {
  const { username, email, password, emailNotifications } = data;
  
  if (users.has(username)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Username already exists' }));
    return;
  }
  
  const user = {
    username,
    email,
    password, // In production, hash this!
    emailNotifications: emailNotifications !== false,
    createdAt: new Date().toISOString()
  };
  
  users.set(username, user);
  
  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ 
    success: true, 
    user: { username, email, emailNotifications: user.emailNotifications }
  }));
  
  console.log(`[AUTH] User signed up: ${username}`);
}

function handleLogin(data, res) {
  const { username, password } = data;
  const user = users.get(username);
  
  if (!user || user.password !== password) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid credentials' }));
    return;
  }
  
  const token = generateToken();
  sessions.set(token, { username, createdAt: new Date().toISOString() });
  
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    success: true,
    token,
    user: {
      username: user.username,
      email: user.email,
      emailNotifications: user.emailNotifications
    }
  }));
  
  console.log(`[AUTH] User logged in: ${username}`);
}

function handleGetApps(username, res) {
  const userApps = [];
  apps.forEach((app, id) => {
    if (app.owner === username || isCollaborator(id, username)) {
      userApps.push({ ...app, id });
    }
  });
  
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(userApps));
}

function handleCreateApp(data, res) {
  const { name, description, owner, visibility, wsEnabled } = data;
  const id = 'app-' + Date.now();
  
  const app = {
    id,
    name,
    description,
    owner,
    visibility: visibility || 'public',
    wsEnabled: wsEnabled !== false,
    files: [],
    url: `freehost.io/app/${name}`,
    createdAt: new Date().toISOString()
  };
  
  apps.set(id, app);
  collaborators.set(id, []);
  
  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(app));
  
  console.log(`[APP] Created: ${name} by ${owner}`);
}

function handleGetApp(appId, res) {
  const app = apps.get(appId);
  if (!app) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'App not found' }));
    return;
  }
  
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(app));
}

function handleDeleteApp(appId, username, res) {
  const app = apps.get(appId);
  if (!app) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'App not found' }));
    return;
  }
  
  if (app.owner !== username) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not authorized' }));
    return;
  }
  
  apps.delete(appId);
  comments.delete(appId);
  collaborators.delete(appId);
  
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true }));
  
  console.log(`[APP] Deleted: ${appId}`);
}

function handleGetComments(appId, res) {
  const appComments = comments.get(appId) || [];
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(appComments));
}

function handlePostComment(appId, data, res) {
  const { author, text } = data;
  const comment = {
    id: Date.now(),
    appId,
    author,
    text,
    timestamp: new Date().toISOString(),
    edited: false
  };
  
  if (!comments.has(appId)) {
    comments.set(appId, []);
  }
  comments.get(appId).push(comment);
  
  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(comment));
  
  // Broadcast via WebSocket
  broadcastToApp(appId, { type: 'new_comment', comment });
}

function handleUpdateComment(commentId, data, res) {
  const { text, username } = data;
  
  // Find comment
  let foundComment = null;
  let appId = null;
  
  for (const [aid, appComments] of comments) {
    const comment = appComments.find(c => c.id == commentId);
    if (comment) {
      foundComment = comment;
      appId = aid;
      break;
    }
  }
  
  if (!foundComment) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Comment not found' }));
    return;
  }
  
  // Check permissions
  const app = apps.get(appId);
  const canEdit = foundComment.author === username || 
                  app.owner === username || 
                  isAdmin(appId, username);
  
  if (!canEdit) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not authorized' }));
    return;
  }
  
  foundComment.text = text;
  foundComment.edited = true;
  foundComment.editedAt = new Date().toISOString();
  
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(foundComment));
  
  broadcastToApp(appId, { type: 'comment_updated', comment: foundComment });
}

function handleDeleteComment(commentId, data, res) {
  const { username } = data;
  
  let foundAppId = null;
  let commentIndex = -1;
  
  for (const [aid, appComments] of comments) {
    const idx = appComments.findIndex(c => c.id == commentId);
    if (idx !== -1) {
      foundAppId = aid;
      commentIndex = idx;
      break;
    }
  }
  
  if (!foundAppId) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Comment not found' }));
    return;
  }
  
  const app = apps.get(foundAppId);
  const comment = comments.get(foundAppId)[commentIndex];
  const canDelete = comment.author === username || 
                    app.owner === username || 
                    isAdmin(foundAppId, username);
  
  if (!canDelete) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not authorized' }));
    return;
  }
  
  comments.get(foundAppId).splice(commentIndex, 1);
  
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true }));
  
  broadcastToApp(foundAppId, { type: 'comment_deleted', commentId });
}

function handleGetCollaborators(appId, res) {
  const appCollaborators = collaborators.get(appId) || [];
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(appCollaborators));
}

function handleAddCollaborator(appId, data, res) {
  const { username, role, addedBy } = data;
  const app = apps.get(appId);
  
  if (!app) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'App not found' }));
    return;
  }
  
  if (app.owner !== addedBy) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Only owner can add collaborators' }));
    return;
  }
  
  const appCollaborators = collaborators.get(appId) || [];
  if (appCollaborators.find(c => c.username === username)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Already a collaborator' }));
    return;
  }
  
  const collaborator = {
    username,
    role: role || 'read',
    addedAt: new Date().toISOString(),
    addedBy
  };
  
  appCollaborators.push(collaborator);
  collaborators.set(appId, appCollaborators);
  
  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(collaborator));
  
  broadcastToApp(appId, { 
    type: 'collaborator_added', 
    username, 
    role,
    appId
  });
  
  console.log(`[COLLAB] ${username} added to ${app.name} as ${role}`);
}

function handleRemoveCollaborator(appId, username, data, res) {
  const { removedBy } = data;
  const app = apps.get(appId);
  
  if (!app) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'App not found' }));
    return;
  }
  
  if (app.owner !== removedBy) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Only owner can remove collaborators' }));
    return;
  }
  
  let appCollaborators = collaborators.get(appId) || [];
  appCollaborators = appCollaborators.filter(c => c.username !== username);
  collaborators.set(appId, appCollaborators);
  
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true }));
  
  broadcastToApp(appId, { type: 'collaborator_removed', username });
}

// Helper functions
function isCollaborator(appId, username) {
  const appCollaborators = collaborators.get(appId) || [];
  return appCollaborators.some(c => c.username === username);
}

function isAdmin(appId, username) {
  const appCollaborators = collaborators.get(appId) || [];
  const collab = appCollaborators.find(c => c.username === username);
  return collab && collab.role === 'admin';
}

function generateToken() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

// Start servers
server.listen(PORT, () => {
  console.log(`[HTTP] API Server running on port ${PORT}`);
});

console.log(`[WS] WebSocket Server running on port ${WS_PORT}`);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  server.close(() => {
    wss.close(() => {
      process.exit(0);
    });
  });
});
