const DEFAULT_LICENSE_SERVER_URL = 'https://nepdevtv.online/auth-server';
const AUTH_MODE = String(process.env.AUTH_MODE || '').trim().toLowerCase();

// Centralized auth is the default. Local first-run setup is opt-in only.
const isLicenseMode = AUTH_MODE !== 'local';
const licenseServerUrl = isLicenseMode
    ? (process.env.LICENSE_SERVER_URL || DEFAULT_LICENSE_SERVER_URL)
    : null;

module.exports = {
    AUTH_MODE,
    DEFAULT_LICENSE_SERVER_URL,
    isLicenseMode,
    licenseServerUrl,
};
