const express = require('express');
const router = express.Router();
const db = require('../db');
const auth = require('../auth');
const { resolveRequestDeviceMac } = require('../services/deviceIdentity');

// Detect auth mode: license server (remote PHP) vs local DB
const LICENSE_SERVER_URL = process.env.LICENSE_SERVER_URL;
const isLicenseMode = !!LICENSE_SERVER_URL;

if (isLicenseMode) {
    console.log('[Auth] License server mode — forwarding auth to', LICENSE_SERVER_URL);
} else {
    console.log('[Auth] Local DB mode — using built-in user management');
}

// ============================================================
// Local DB mode — Passport strategies (only when NOT using license server)
// ============================================================
if (!isLicenseMode) {
    auth.configureLocalStrategy(
        async (username) => await db.users.getByUsername(username),
        async (password, hash) => await auth.verifyPassword(password, hash)
    );

    auth.configureJwtStrategy(
        async (id) => await db.users.getById(id)
    );

    auth.configureSessionSerialization(
        async (id) => await db.users.getById(id)
    );

    auth.configureOidcStrategy(
        async (oidcId) => await db.users.getByOidcId(oidcId),
        async (email) => await db.users.getByEmail(email),
        async (userData) => await db.users.create(userData)
    );
}

// ============================================================
// OIDC routes (local mode only)
// ============================================================
if (!isLicenseMode) {
    router.get('/oidc/login', auth.passport.authenticate('openidconnect'));

    router.get('/oidc/callback',
        auth.passport.authenticate('openidconnect', { session: false, failureRedirect: '/login.html?error=SSO+Failed' }),
        (req, res) => {
            const token = auth.generateToken(req.user);
            res.redirect(`/?token=${token}`);
        }
    );
}

// ============================================================
// Setup routes (local mode only)
// ============================================================
if (!isLicenseMode) {
    router.get('/setup-required', async (req, res) => {
        try {
            const userCount = await db.users.count();
            res.json({ setupRequired: userCount === 0 });
        } catch (err) {
            console.error('Error in /setup-required:', err);
            res.status(500).json({ error: 'Server error' });
        }
    });

    router.post('/setup', async (req, res) => {
        try {
            const userCount = await db.users.count();
            if (userCount > 0) {
                return res.status(400).json({ error: 'Setup already completed' });
            }

            const { username, password } = req.body;
            if (!username || !password) {
                return res.status(400).json({ error: 'Username and password required' });
            }
            if (password.length < 6) {
                return res.status(400).json({ error: 'Password must be at least 6 characters' });
            }

            const passwordHash = await auth.hashPassword(password);
            const adminUser = await db.users.create({ username, passwordHash, role: 'admin' });
            const token = auth.generateToken(adminUser);

            res.status(201).json({ message: 'Admin user created successfully', token, user: adminUser });
        } catch (err) {
            console.error('Error in /setup:', err);
            res.status(500).json({ error: err.message || 'Server error' });
        }
    });
}

// ============================================================
// License server mode — setup-required always returns false
// ============================================================
if (isLicenseMode) {
    router.get('/setup-required', (req, res) => {
        res.json({ setupRequired: false });
    });
}

// ============================================================
// Register (license server mode only — local mode creates users via admin)
// ============================================================
if (isLicenseMode) {
    router.post('/register', async (req, res) => {
        try {
            const { username, password, fullname, email } = req.body;
            if (!username || !password || !fullname) {
                return res.status(400).json({ error: 'Full name, username, and password required' });
            }

            const deviceId = await resolveRequestDeviceMac(req);
            if (!deviceId) {
                return res.status(400).json({ error: 'Unable to detect this device MAC address for registration' });
            }

            const licenseService = require('../services/licenseService').getInstance();
            const result = await licenseService.register(username, password, email || null, fullname, deviceId);

            if (result.error) {
                return res.status(400).json({ error: result.message || 'Registration failed' });
            }

            res.status(201).json({
                message: result.message || 'Registration successful. Your account is pending admin approval.',
                pending: true
            });
        } catch (err) {
            console.error('[Auth] Register error:', err);
            res.status(500).json({ error: 'Server error' });
        }
    });
}

// ============================================================
// Login — dual mode
// ============================================================
if (isLicenseMode) {
    router.post('/login', async (req, res) => {
        try {
            const { username, password } = req.body;
            if (!username || !password) {
                return res.status(400).json({ error: 'Username and password required' });
            }

            const licenseService = require('../services/licenseService').getInstance();
            const deviceId = await resolveRequestDeviceMac(req);
            if (!deviceId) {
                return res.status(400).json({ error: 'Unable to detect this device MAC address for login' });
            }
            const result = await licenseService.login(username, password, deviceId);

            if (result.error) {
                const status = result.status
                    || (result.message?.includes('pending') ? 403
                        : result.message?.includes('blocked') ? 403
                        : /device|mac/i.test(result.message || '') ? 403
                        : 401);
                return res.status(status).json({ error: result.message || 'Login failed' });
            }

            res.json({
                token: result.token,
                user: result.user || { username, role: 'viewer' }
            });
        } catch (err) {
            console.error('[Auth] License login error:', err);
            res.status(500).json({ error: 'Server error' });
        }
    });
} else {
    router.post('/login', (req, res, next) => {
        auth.passport.authenticate('local', { session: false }, (err, user, info) => {
            if (err) {
                console.error('Login error:', err);
                return res.status(500).json({ error: 'Server error' });
            }
            if (!user) {
                return res.status(401).json({ error: info?.message || 'Invalid credentials' });
            }

            const token = auth.generateToken(user);
            res.json({
                token,
                user: { id: user.id, username: user.username, role: user.role }
            });
        })(req, res, next);
    });
}

// ============================================================
// Logout — dual mode
// ============================================================
router.post('/logout', (req, res) => {
    if (isLicenseMode) {
        // Invalidate cached token
        const authHeader = req.headers.authorization || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (token) {
            const licenseService = require('../services/licenseService').getInstance();
            licenseService.invalidateCache(token);
        }
    }
    res.json({ success: true, message: 'Logged out successfully' });
});

// ============================================================
// Get current user (/me) — dual mode
// ============================================================
if (isLicenseMode) {
    router.get('/me', auth.requireLicenseAuth(), async (req, res) => {
        res.json({
            id: req.user.id,
            username: req.user.username,
            role: req.user.role
        });
    });
} else {
    router.get('/me', auth.requireAuth, async (req, res) => {
        try {
            const user = await db.users.getById(req.user.id);
            if (!user) {
                return res.status(404).json({ error: 'User not found' });
            }
            res.json({ id: user.id, username: user.username, role: user.role });
        } catch (err) {
            console.error('Error in /me:', err);
            res.status(500).json({ error: 'Server error' });
        }
    });
}

// ============================================================
// Admin user management — dual mode
// ============================================================
if (isLicenseMode) {
    // List users (forwarded to PHP server)
    router.get('/users', auth.requireLicenseAuth(), auth.requireLicenseAdmin, async (req, res) => {
        try {
            const licenseService = require('../services/licenseService').getInstance();
            const statusFilter = req.query.status || null;
            const result = await licenseService.getUsers(req.licenseToken, statusFilter);

            if (result.error) {
                return res.status(400).json({ error: result.message });
            }
            res.json(result.users || []);
        } catch (err) {
            console.error('[Auth] Get users error:', err);
            res.status(500).json({ error: 'Server error' });
        }
    });

    // Get stats
    router.get('/users/stats', auth.requireLicenseAuth(), auth.requireLicenseAdmin, async (req, res) => {
        try {
            const licenseService = require('../services/licenseService').getInstance();
            const result = await licenseService.getStats(req.licenseToken);

            if (result.error) {
                return res.status(400).json({ error: result.message });
            }
            res.json(result.stats || {});
        } catch (err) {
            console.error('[Auth] Get stats error:', err);
            res.status(500).json({ error: 'Server error' });
        }
    });

    // Update user (approve, block, reset IP, change role)
    router.put('/users/:id', auth.requireLicenseAuth(), auth.requireLicenseAdmin, async (req, res) => {
        try {
            const licenseService = require('../services/licenseService').getInstance();
            const result = await licenseService.updateUser(req.licenseToken, req.params.id, req.body);

            if (result.error) {
                return res.status(400).json({ error: result.message });
            }
            res.json({ success: true, message: result.message || 'User updated' });
        } catch (err) {
            console.error('[Auth] Update user error:', err);
            res.status(500).json({ error: 'Server error' });
        }
    });

    // Delete user
    router.delete('/users/:id', auth.requireLicenseAuth(), auth.requireLicenseAdmin, async (req, res) => {
        try {
            const licenseService = require('../services/licenseService').getInstance();
            const result = await licenseService.deleteUser(req.licenseToken, req.params.id);

            if (result.error) {
                return res.status(400).json({ error: result.message });
            }
            res.json({ success: true, message: result.message || 'User deleted' });
        } catch (err) {
            console.error('[Auth] Delete user error:', err);
            res.status(500).json({ error: 'Server error' });
        }
    });
} else {
    // Local DB mode — existing user management
    router.get('/users', auth.requireAuth, auth.requireAdmin, async (req, res) => {
        try {
            const allUsers = await db.users.getAll();
            const users = allUsers.map(u => {
                const { passwordHash, ...userWithoutPassword } = u;
                return userWithoutPassword;
            });
            res.json(users);
        } catch (err) {
            console.error('Error fetching users:', err);
            res.status(500).json({ error: 'Server error' });
        }
    });

    router.post('/users', auth.requireAuth, auth.requireAdmin, async (req, res) => {
        try {
            const { username, password, role } = req.body;
            if (!username || !password || !role) {
                return res.status(400).json({ error: 'Username, password, and role are required' });
            }
            if (password.length < 6) {
                return res.status(400).json({ error: 'Password must be at least 6 characters' });
            }
            if (!['admin', 'viewer'].includes(role)) {
                return res.status(400).json({ error: 'Role must be either "admin" or "viewer"' });
            }

            const passwordHash = await auth.hashPassword(password);
            const newUser = await db.users.create({ username, passwordHash, role });
            res.status(201).json(newUser);
        } catch (err) {
            console.error('Error creating user:', err);
            res.status(500).json({ error: err.message || 'Server error' });
        }
    });

    router.put('/users/:id', auth.requireAuth, auth.requireAdmin, async (req, res) => {
        try {
            const { id } = req.params;
            const { username, password, role } = req.body;
            const updates = {};

            if (username) updates.username = username;
            if (password) {
                if (password.length < 6) {
                    return res.status(400).json({ error: 'Password must be at least 6 characters' });
                }
                updates.passwordHash = await auth.hashPassword(password);
            }
            if (role) {
                if (!['admin', 'viewer'].includes(role)) {
                    return res.status(400).json({ error: 'Role must be either "admin" or "viewer"' });
                }
                const user = await db.users.getById(id);
                if (user && user.role === 'admin' && role !== 'admin') {
                    const allUsers = await db.users.getAll();
                    const adminCount = allUsers.filter(u => u.role === 'admin').length;
                    if (adminCount <= 1) {
                        return res.status(400).json({ error: 'Cannot remove admin role from the last admin user' });
                    }
                }
                updates.role = role;
            }

            const updatedUser = await db.users.update(id, updates);
            res.json(updatedUser);
        } catch (err) {
            console.error('Error updating user:', err);
            res.status(500).json({ error: err.message || 'Server error' });
        }
    });

    router.delete('/users/:id', auth.requireAuth, auth.requireAdmin, async (req, res) => {
        try {
            const { id } = req.params;
            if (parseInt(id) === req.user.id) {
                return res.status(400).json({ error: 'Cannot delete your own account' });
            }
            await db.users.delete(id);
            res.json({ success: true, message: 'User deleted successfully' });
        } catch (err) {
            console.error('Error deleting user:', err);
            res.status(500).json({ error: err.message || 'Server error' });
        }
    });
}

// ============================================================
// Auth mode info endpoint — tells the frontend which mode is active
// ============================================================
router.get('/mode', (req, res) => {
    res.json({
        mode: isLicenseMode ? 'license' : 'local',
        registrationEnabled: isLicenseMode
    });
});

module.exports = router;
