let statusChecks = 0;

globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  let body;

  if (options.method === 'POST' && url.endsWith('/api/setup/start')) {
    body = { session_id: 'setup-session', expires_in: 1800 };
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
          delivery_preference: 'both',
          forms: [
            { id: 'feature-123', type: 'feature_request', name: 'Suggest a Feature', created: true },
            { id: 'subscription-123', type: 'cancellation', name: 'Cancellation Feedback', created: true },
            { id: 'trial-123', type: 'trial_expiration', name: 'Trial Cancellation Feedback', created: true },
          ],
        };
  } else if (url.endsWith('/api/slack/app-123/status')) {
    body = {
      connected: true,
      team_name: 'Example Workspace',
      default_channel_id: 'C-CANCEL',
      default_channel_name: 'paydirt-cancellations',
      feature_channel_id: 'C-FEATURE',
      feature_channel_name: 'paydirt-suggest-a-feature',
      cancellation_channel_id: 'C-CANCEL',
      cancellation_channel_name: 'paydirt-cancellations',
      two_channel_routing: true,
      form_count: 3,
      assigned_form_count: 3,
      all_forms_assigned: true,
      assignments: {
        feature: { assigned: 1, total: 1, complete: true },
        cancellation: { assigned: 2, total: 2, complete: true },
      },
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
