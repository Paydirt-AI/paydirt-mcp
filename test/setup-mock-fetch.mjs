let statusChecks = 0;

globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  let body;

  if (options.method === 'POST' && url.endsWith('/api/setup/start')) {
    body = { session_id: 'setup-session', expires_in: 600 };
  } else if (url.endsWith('/api/setup/status/setup-session')) {
    statusChecks += 1;
    body = statusChecks === 1
      ? { status: 'pending' }
      : {
          status: 'ready',
          auth_token: 'private-user-token',
          api_key: 'public-sdk-key',
          app_id: 'app-123',
          action: 'created',
          forms: [{ id: 'feedback-123', type: 'custom', name: 'Feedback', created: true }],
        };
  } else {
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
