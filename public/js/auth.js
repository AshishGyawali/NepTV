/**
 * Auth Manager - Frontend authentication state management
 * Supports both local DB mode and license server mode
 */

const Auth = {
    currentUser: null,
    authMode: 'local', // 'local' or 'license'

    /**
     * Initialize auth - check setup status and current user
     */
    async init() {
        try {
            // Detect auth mode
            try {
                const modeInfo = await API.auth.mode();
                this.authMode = modeInfo.mode || 'local';
            } catch (e) {
                // Fallback to local if mode endpoint unavailable
            }

            // Check if setup is required (local mode only, license mode always returns false)
            const setupStatus = await API.auth.checkSetup();
            if (setupStatus.setupRequired) {
                this.showSetup();
                return false;
            }

            // Check if user is logged in
            if (API.getToken()) {
                try {
                    this.currentUser = await API.auth.me();
                    return true;
                } catch (error) {
                    // Token invalid, clear it
                    console.log('Token invalid, showing login');
                    API.setToken(null);
                    this.showLogin();
                    return false;
                }
            } else {
                this.showLogin();
                return false;
            }
        } catch (error) {
            console.error('Auth initialization failed:', error);
            this.showLogin();
            return false;
        }
    },

    /**
     * Show setup screen
     */
    showSetup() {
        document.getElementById('setup-screen').classList.add('active');
        document.getElementById('login-screen').classList.remove('active');
        document.getElementById('app').classList.remove('active');
    },

    /**
     * Show login screen
     */
    showLogin() {
        document.getElementById('setup-screen').classList.remove('active');
        document.getElementById('login-screen').classList.add('active');
        document.getElementById('app').classList.remove('active');
    },

    /**
     * Show main app
     */
    showApp() {
        document.getElementById('setup-screen').classList.remove('active');
        document.getElementById('login-screen').classList.remove('active');
        document.getElementById('app').classList.add('active');
    },

    /**
     * Setup initial admin user (local mode only)
     */
    async setup(username, password) {
        try {
            const result = await API.auth.setup(username, password);
            API.setToken(result.token);
            this.currentUser = result.user;
            this.showApp();
            return true;
        } catch (error) {
            throw error;
        }
    },

    /**
     * Login user
     */
    async login(username, password) {
        try {
            const result = await API.auth.login(username, password);
            API.setToken(result.token);
            this.currentUser = result.user;
            this.showApp();
            return true;
        } catch (error) {
            throw error;
        }
    },

    /**
     * Logout user
     */
    async logout() {
        try {
            await API.auth.logout();
        } catch (error) {
            console.error('Logout error:', error);
        } finally {
            API.setToken(null);
            this.currentUser = null;
            this.showLogin();
        }
    },

    /**
     * Check if current user is admin
     */
    isAdmin() {
        return this.currentUser && this.currentUser.role === 'admin';
    },

    /**
     * Check if current user is viewer
     */
    isViewer() {
        return this.currentUser && this.currentUser.role === 'viewer';
    },

    /**
     * Get current user
     */
    getCurrentUser() {
        return this.currentUser;
    }
};
