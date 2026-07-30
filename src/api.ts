// API client for Paydirt backend

const API_BASE_URL = process.env.PAYDIRT_API_URL || 'https://api.paydirt.ai';

interface ApiOptions {
  method?: string;
  body?: Record<string, unknown>;
  token?: string;
}

export async function apiRequest<T>(
  endpoint: string,
  options: ApiOptions = {}
): Promise<T> {
  const { method = 'GET', body, token } = options;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error: ${response.status} - ${error}`);
  }

  return response.json() as Promise<T>;
}

// App types
export interface App {
  id: string;
  name: string;
  bundle_id: string | null;
  api_key: string;
  app_description: string | null;
  system_prompt?: string | null;
  app_context_prompt?: string | null;
  created_at: string;
}

// Form types
export interface Form {
  id: string;
  app_id: string;
  name: string;
  type: 'cancellation' | 'trial_expiration' | 'feature_request' | 'custom';
  prompt: string;
  custom_system_prompt: string | null;
  slack_channel_id: string | null;
  enabled: boolean;
  created_at: string;
}

// Response types
export interface Response {
  id: string;
  form_id: string;
  app_id: string;
  user_id_external: string | null;
  conversation: Array<{ role: string; content: string }>;
  ai_summary: string | null;
  suggested_action: string | null;
  metadata: Record<string, unknown> | null;
  status: 'in_progress' | 'completed' | 'abandoned';
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

// Summary types
export interface Summary {
  summary: string;
  top_reasons: string[];
  response_count: number;
  period: string;
}

// Slack types
export interface SlackChannel {
  id: string;
  name: string;
}

// API functions
export async function listApps(token: string): Promise<App[]> {
  const { apps } = await apiRequest<{ apps: App[] }>('/api/apps', { token });
  return apps;
}

export async function createApp(
  token: string,
  data: { name: string; bundle_id?: string; app_description?: string }
): Promise<App> {
  const { app } = await apiRequest<{ app: App }>('/api/apps', {
    method: 'POST',
    body: data,
    token,
  });
  return app;
}

export async function getApp(token: string, appId: string): Promise<App> {
  const { app } = await apiRequest<{ app: App }>(`/api/apps/${appId}`, { token });
  return app;
}

export async function listForms(token: string, appId: string): Promise<Form[]> {
  const { forms } = await apiRequest<{ forms: Form[] }>(`/api/apps/${appId}/forms`, { token });
  return forms;
}

export async function createForm(
  token: string,
  appId: string,
  data: {
    name: string;
    type: string;
    prompt: string;
    custom_system_prompt?: string;
  }
): Promise<Form> {
  const { form } = await apiRequest<{ form: Form }>(`/api/apps/${appId}/forms`, {
    method: 'POST',
    body: data,
    token,
  });
  return form;
}

export async function getResponses(
  token: string,
  appId: string,
  options: {
    formId?: string;
    status?: 'completed' | 'in_progress' | 'abandoned' | 'all';
    since?: string;
    limit?: number;
  } = {}
): Promise<Response[]> {
  const params = new URLSearchParams();
  if (options.formId) params.set('form_id', options.formId);
  if (options.status) params.set('status', options.status);
  if (options.since) params.set('date_from', options.since);
  if (options.limit) params.set('limit', String(options.limit));
  const query = params.toString();
  const endpoint = `/api/apps/${appId}/responses${query ? `?${query}` : ''}`;
  const { responses } = await apiRequest<{ responses: Response[] }>(endpoint, { token });
  return responses;
}

export async function getSummary(
  token: string,
  appId: string,
  formId?: string,
  days?: number
): Promise<Summary> {
  let endpoint = `/api/apps/${appId}/summary`;
  const params = new URLSearchParams();
  if (formId) params.append('form_id', formId);
  if (days) params.append('days', days.toString());
  if (params.toString()) endpoint += `?${params.toString()}`;

  return apiRequest<Summary>(endpoint, { token });
}

export async function getSlackInstallUrl(token: string, appId: string): Promise<{ auth_url: string }> {
  return apiRequest<{ auth_url: string }>(`/api/slack/install?app_id=${appId}`, { token });
}

export async function listSlackChannels(
  token: string,
  appId: string
): Promise<{ channels: SlackChannel[]; team_name: string }> {
  return apiRequest<{ channels: SlackChannel[]; team_name: string }>(`/api/slack/${appId}/channels`, { token });
}

export async function setFormSlackChannel(
  token: string,
  _appId: string,
  formId: string,
  channelId: string
): Promise<{ form: Form }> {
  return apiRequest<{ form: Form }>(`/api/forms/${formId}`, {
    method: 'PUT',
    body: { slack_channel_id: channelId },
    token,
  });
}

export async function updateForm(
  token: string,
  formId: string,
  data: {
    name?: string;
    prompt?: string;
    custom_system_prompt?: string;
    enabled?: boolean;
  }
): Promise<{ form: Form }> {
  return apiRequest<{ form: Form }>(`/api/forms/${formId}`, {
    method: 'PUT',
    body: data,
    token,
  });
}

// New API functions

// Health check - verify API connectivity
export async function healthCheck(token: string): Promise<{ status: string; authenticated: boolean }> {
  try {
    // Try to list apps to verify authentication
    await listApps(token);
    return { status: 'ok', authenticated: true };
  } catch {
    return { status: 'error', authenticated: false };
  }
}

// Update app settings
export async function updateApp(
  token: string,
  appId: string,
  data: {
    name?: string;
    bundle_id?: string;
    app_description?: string;
    system_prompt?: string;
    app_context_prompt?: string;
  }
): Promise<App> {
  const { app } = await apiRequest<{ app: App }>(`/api/apps/${appId}`, {
    method: 'PUT',
    body: data,
    token,
  });
  return app;
}

// Get single form details
export async function getForm(token: string, formId: string): Promise<{ form: Form }> {
  return apiRequest<{ form: Form }>(`/api/forms/${formId}`, { token });
}

// Delete a form
export async function deleteForm(token: string, formId: string): Promise<{ success: boolean }> {
  return apiRequest<{ success: boolean }>(`/api/forms/${formId}`, {
    method: 'DELETE',
    token,
  });
}

// Get Slack connection status
export async function getSlackStatus(
  token: string,
  appId: string
): Promise<{ connected: boolean; team_name: string | null }> {
  return apiRequest<{ connected: boolean; team_name: string | null }>(
    `/api/slack/${appId}/status`,
    { token }
  );
}

// Toggle form enabled status
export async function toggleForm(
  token: string,
  formId: string,
  enabled: boolean
): Promise<{ form: Form }> {
  return apiRequest<{ form: Form }>(`/api/forms/${formId}`, {
    method: 'PUT',
    body: { enabled },
    token,
  });
}

// Setup session types and functions (no auth required)
export interface SetupSession {
  session_id: string;
  expires_in: number;
}

export interface SetupStatus {
  status: 'pending' | 'ready' | 'expired';
  api_key?: string;
  auth_token?: string;
  app_id?: string;
  action?: 'created' | 'reused' | 'repaired';
  forms?: Array<{
    id: string;
    type: Form['type'];
    name: string;
    created: boolean;
  }>;
}

// Start a setup session (no auth required)
export async function startSetupSession(): Promise<SetupSession> {
  return apiRequest<SetupSession>('/api/setup/start', { method: 'POST' });
}

// Check setup session status (no auth required)
export async function getSetupStatus(sessionId: string): Promise<SetupStatus> {
  return apiRequest<SetupStatus>(`/api/setup/status/${sessionId}`);
}

// Ask a question about feedback data
export interface AskResponse {
  answer: string;
  response_count: number;
  days: number;
}

export async function askQuestion(
  token: string,
  appId: string,
  question: string,
  formId?: string,
  days?: number
): Promise<AskResponse> {
  return apiRequest<AskResponse>(`/api/apps/${appId}/ask`, {
    method: 'POST',
    body: {
      question,
      form_id: formId,
      days: days || 30,
    },
    token,
  });
}
