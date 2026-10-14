/**
 * Auth.gs
 * Sign-up, email OTP, and session management.
 *
 * Nothing sensitive is stored in plain text: OTP codes are stored as
 * sha256(code + email + SALT) and session tokens as sha256(token + SALT),
 * both in their own tabs with an expiry.
 */

var Auth = {

  /* ---------------------------- signup ---------------------------- */
  signup: function (p) {
    var email = normEmail(p.email);
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new Error('A valid email address is required.');
    }
    var domain = String(cfg('ALLOWED_DOMAIN') || '').toLowerCase();
    if (domain && email.split('@')[1] !== domain) {
      throw new Error('Please sign up with your @' + domain + ' email address.');
    }
    if (Db.findOne(SHEETS.USERS, function (u) { return normEmail(u.Email) === email; })) {
      throw new Error('An account with this email already exists. Please log in.');
    }
    if (!p.name || !String(p.name).trim()) throw new Error('Full name is required.');
    if (!/^[6-9]\d{9}$/.test(String(p.phone || '').trim())) {
      throw new Error('Enter a valid 10-digit mobile number.');
    }
    if (!p.department || !String(p.department).trim()) throw new Error('Department is required.');

    var clusterId = String(p.clusterId || '').trim();
    var cluster = clusterId
      ? Db.findOne(SHEETS.CLUSTERS, function (c) { return String(c.ClusterID) === clusterId; })
      : null;
    if (clusterId && !cluster) throw new Error('Please choose a valid cluster.');

    // Role is ALWAYS USER for self sign-up — client-supplied role is ignored.
    var user = {
      UserID: Db.nextId('U-', SHEETS.USERS, 'UserID'),
      Name: String(p.name).trim(),
      Email: email,
      Phone: String(p.phone).trim(),
      Department: String(p.department).trim(),
      DefaultPriority: PRIORITIES.indexOf(p.defaultPriority) >= 0 ? p.defaultPriority : 'Medium',
      Role: ROLES.USER,
      ClusterID: cluster ? String(cluster.ClusterID) : '',
      ReportsTo: '',
      Status: 'ACTIVE',
      CreatedAt: now().toISOString(),
      LastLoginAt: ''
    };

    withLock(function () { Db.insert(SHEETS.USERS, user); });
    Auth.logActivity(user, 'SIGNUP', user.Email);
    try { mailWelcome(email, user.Name); } catch (e) { logErr('welcomeMail', e); }
    return { registered: true, email: email };
  },

  /* -------------------------- request OTP -------------------------- */
  requestOtp: function (p) {
    var email = normEmail(p.email);
    if (!email) throw new Error('Please enter your email.');
    var GENERIC = "If this email is registered, we've sent an OTP.";

    var user = Db.findOne(SHEETS.USERS, function (u) { return normEmail(u.Email) === email; });

    // Rate limit: one OTP per OTP_RESEND_SEC window (only for real users).
    var existing = Db.findOne(SHEETS.OTP, function (r) { return normEmail(r.Email) === email; });
    if (existing) {
      var createdMs = toMs(existing.CreatedAt);
      var waitMs = cfgNum('OTP_RESEND_SEC') * 1000;
      if (createdMs && Date.now() - createdMs < waitMs) {
        throw new Error('Please wait ' + cfgNum('OTP_RESEND_SEC') +
          ' seconds before requesting another OTP.');
      }
    }

    // Always pretend success for unknown/inactive users (email enumeration guard).
    if (!user || String(user.Status).toUpperCase() !== 'ACTIVE') {
      return { email: email, sent: true, message: GENERIC };
    }

    var otp = randomOtp();
    var exp = addMinutes(now(), cfgNum('OTP_EXPIRY_MIN'));
    withLock(function () {
      Db.upsert(SHEETS.OTP, 'Email', email, {
        Email: email,
        OtpHash: sha256(otp + '|' + email),
        ExpiresAt: exp,
        Attempts: 0,
        CreatedAt: now()
      });
    });

    var sent = mailOtp(email, user.Name, otp);
    if (!sent) throw new Error('Could not send the OTP email. Please try again.');
    Auth.logActivity(user, 'OTP_REQUEST', email);
    return { email: email, sent: true, ttlMinutes: cfgNum('OTP_EXPIRY_MIN') };
  },

  /* --------------------------- verify OTP -------------------------- */
  verifyOtp: function (p) {
    var email = normEmail(p.email);
    var code = String(p.code || '').trim();
    if (!code) throw new Error('Please enter the OTP.');

    var rec = Db.findOne(SHEETS.OTP, function (r) { return normEmail(r.Email) === email; });
    if (!rec) throw new Error('No OTP was requested for this email.');

    if (toMs(rec.ExpiresAt) < Date.now()) {
      Db.deleteWhere(SHEETS.OTP, function (r) { return normEmail(r.Email) === email; });
      throw new Error('OTP expired. Please request a new one.');
    }
    var tries = Number(rec.Attempts || 0);
    if (tries >= cfgNum('OTP_MAX_ATTEMPTS')) {
      Db.deleteWhere(SHEETS.OTP, function (r) { return normEmail(r.Email) === email; });
      throw new Error('Too many incorrect attempts. Please request a new OTP.');
    }
    if (sha256(code + '|' + email) !== String(rec.OtpHash)) {
      Db.update(SHEETS.OTP, rec._row, { Attempts: tries + 1 });
      throw new Error('Incorrect OTP. Attempts left: ' + (cfgNum('OTP_MAX_ATTEMPTS') - tries - 1));
    }

    Db.deleteWhere(SHEETS.OTP, function (r) { return normEmail(r.Email) === email; });

    var user = Db.findOne(SHEETS.USERS, function (u) { return normEmail(u.Email) === email; });
    if (!user || String(user.Status).toUpperCase() !== 'ACTIVE') {
      throw new Error('Account is not available.');
    }

    Db.update(SHEETS.USERS, user._row, { LastLoginAt: now().toISOString() });
    var token = Auth.createSession(user);
    Auth.logActivity(user, 'LOGIN', email);
    return { token: token, user: Auth.publicUser(user) };
  },

  /* --------------------------- sessions ---------------------------- */
  createSession: function (user) {
    var token = randomToken();
    Db.insert(SHEETS.SESSIONS, {
      TokenHash: sha256(token),
      Email: normEmail(user.Email),
      Role: String(user.Role || '').toUpperCase(),
      CreatedAt: now(),
      ExpiresAt: addHours(now(), cfgNum('SESSION_HOURS')),
      LastSeenAt: now()
    });
    return token;
  },

  requireSession: function (token) {
    if (!token) throw new Error('SESSION_EXPIRED');
    var rec = Db.findOne(SHEETS.SESSIONS, function (s) { return String(s.TokenHash) === sha256(token); });
    if (!rec) throw new Error('SESSION_EXPIRED');

    if (toMs(rec.ExpiresAt) < Date.now()) {
      Db.deleteWhere(SHEETS.SESSIONS, function (s) { return String(s.TokenHash) === sha256(token); });
      throw new Error('SESSION_EXPIRED');
    }

    var user = Db.findOne(SHEETS.USERS, function (u) { return normEmail(u.Email) === normEmail(rec.Email); });
    if (!user) throw new Error('SESSION_EXPIRED');
    if (String(user.Status).toUpperCase() !== 'ACTIVE') {
      throw new Error('Your account is inactive. Contact the admin.');
    }

    // Refresh LastSeenAt at most once every SILENT_SESSION_MIN minutes (quota friendly).
    var seenMs = toMs(rec.LastSeenAt);
    if (!seenMs || Date.now() - seenMs > cfgNum('SILENT_SESSION_MIN') * 60000) {
      Db.update(SHEETS.SESSIONS, rec._row, { LastSeenAt: now() });
    }

    user.Role = String(user.Role || '').toUpperCase();
    return user;
  },

  logout: function (token) {
    if (token) Db.deleteWhere(SHEETS.SESSIONS, function (s) { return String(s.TokenHash) === sha256(token); });
    return { loggedOut: true };
  },

  /** Kills every session for an email (used after role/status changes). */
  killSessions: function (email) {
    var e = normEmail(email);
    return Db.deleteWhere(SHEETS.SESSIONS, function (s) { return normEmail(s.Email) === e; });
  },

  /* ---------------------------- helpers ---------------------------- */
  publicUser: function (u) {
    return {
      userId: u.UserID,
      name: u.Name || '',
      email: normEmail(u.Email),
      phone: u.Phone || '',
      department: u.Department || '',
      role: String(u.Role || 'USER').toUpperCase(),
      clusterId: u.ClusterID || '',
      defaultPriority: u.DefaultPriority || 'Medium',
      reportsTo: u.ReportsTo || ''
    };
  },

  me: function (user) { return Auth.publicUser(user); },

  logActivity: function (user, event, meta) {
    if (!user) return;
    Db.insert(SHEETS.ACTIVITY, {
      Timestamp: now(),
      Email: normEmail(user.Email),
      Role: String(user.Role || '').toUpperCase(),
      Event: event,
      Meta: meta || ''
    });
  }
};
