// Chatwoot API helpers. Two surfaces:
//   - Platform API (CHATWOOT_PLATFORM_ACCESS_TOKEN): create accounts/users,
//     attach account_users. Installation-level.
//   - Application API (CHATWOOT_ACCESS_TOKEN, a user token): create inboxes,
//     members, automations within an account.

export function chatwootBase() {
  return (process.env.CHATWOOT_BASE_URL || process.env.CHATWOOT_HOST || '').replace(/\/+$/, '');
}

async function request(pathSuffix, token, opts = {}) {
  const r = await fetch(`${chatwootBase()}${pathSuffix}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      api_access_token: token,
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  return { status: r.status, ok: r.ok, body };
}

// Platform API (installation-level token).
export function platform(pathSuffix, opts = {}) {
  return request(pathSuffix, process.env.CHATWOOT_PLATFORM_ACCESS_TOKEN, opts);
}

// Application API (user token).
export function app(pathSuffix, opts = {}) {
  return request(pathSuffix, process.env.CHATWOOT_ACCESS_TOKEN, opts);
}

// Lisbon working hours: Mon–Fri 09:00–17:00, weekends closed.
// Mon-Fri 09:00-17:00, weekends closed. Nothing about this is city-specific —
// only the old name was. Kept as businessHours(); lisbonWorkingHours is a
// deprecated alias so existing callers keep working.
export function businessHours() {
  return [0, 1, 2, 3, 4, 5, 6].map((day) => {
    const weekend = day === 0 || day === 6;
    return {
      day_of_week: day,
      closed_all_day: weekend,
      open_hour: weekend ? null : 9,
      open_minutes: weekend ? null : 0,
      close_hour: weekend ? null : 17,
      close_minutes: weekend ? null : 0,
      open_all_day: false,
    };
  });
}

// Deprecated: use businessHours(). Retained so older skills do not break.
export const lisbonWorkingHours = businessHours;
