// Optional access rules for SSO logins, checked on every login (also for existing accounts, so removing a
// user from the group revokes access). Without any rule every user the identity provider authenticates may log in.
//   OIDC_ALLOWED_GROUPS         comma-separated, matched against the "groups" claim (the IdP must send it)
//   OIDC_ALLOWED_EMAIL_DOMAINS  comma-separated, only counts with email_verified = true
// Either one is enough.

const splitList = (value) => String(value || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function createSsoAccess({ groups, domains } = {}) {
  const allowedGroups = splitList(groups);
  const allowedDomains = splitList(domains);
  return {
    restricted: allowedGroups.length > 0 || allowedDomains.length > 0,
    needsGroupsClaim: allowedGroups.length > 0,
    allowed(claims) {
      if (!allowedGroups.length && !allowedDomains.length) return true;
      const own = Array.isArray(claims.groups) ? claims.groups.map((g) => String(g).toLowerCase()) : [];
      if (own.some((g) => allowedGroups.includes(g))) return true;
      const domain = typeof claims.email === 'string' ? claims.email.split('@').pop().toLowerCase() : '';
      return claims.email_verified === true && allowedDomains.includes(domain);
    },
  };
}

module.exports = { createSsoAccess, splitList };
