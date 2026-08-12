export type FeedbackTrigger =
  | 'user_tap'
  | 'in_app_action'
  | 'screen_appearance'
  | 'custom_condition';

export interface PlacementForm {
  id: string;
  name: string;
  type: string;
  prompt: string;
  slack_channel_id: string | null;
}

export function normalizedFormName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

export function findCustomFormByName<T extends Pick<PlacementForm, 'name' | 'type'>>(
  forms: T[],
  title: string
): T | undefined {
  const normalizedTitle = normalizedFormName(title);
  return forms.find(
    (form) => form.type === 'custom' && normalizedFormName(form.name) === normalizedTitle
  );
}

function swiftString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

function triggerInstruction(trigger: FeedbackTrigger, placement: string): string {
  switch (trigger) {
    case 'user_tap':
      return `Place the presentation call inside the tap handler for ${placement}. Preserve the existing action if there is one.`;
    case 'in_app_action':
      return `Place the presentation call in the successful completion path for ${placement}, not before the action succeeds and not on failure.`;
    case 'screen_appearance':
      return `Present from ${placement} only after the screen is visible. Guard repeated view appearances so one visit does not open the form more than once.`;
    case 'custom_condition':
      return `Present when the host app's condition for ${placement} becomes true. Preserve existing behavior and prevent duplicate presentation for the same event.`;
  }
}

export function feedbackPlacementContract(
  form: PlacementForm,
  placement: string,
  trigger: FeedbackTrigger,
  formAction: 'created' | 'reused' | 'reused_and_updated',
  slack: Record<string, unknown>
) {
  const presentationStatement = `Paydirt.presentForm(formId: "${swiftString(form.id)}", metadata: ["paydirt_placement": "${swiftString(placement)}"])`;
  const slackRequired = slack.status !== 'deferred';

  return {
    success: true,
    form_action: formAction,
    form: {
      id: form.id,
      name: form.name,
      type: form.type,
      initial_question: form.prompt,
    },
    requested_placement: {
      description: placement,
      trigger,
    },
    ios: {
      required_import: 'import Paydirt',
      presentation_statement: presentationStatement,
      placement_instruction: triggerInstruction(trigger, placement),
      note: 'Use the exact form ID. Preserve the existing host-app form, UI, handler, destination, and side effects; add this presentation only at the explicitly requested placement. Adapt only the surrounding control flow and pass a real userId if the app has one.',
    },
    slack,
    agent_actions: [
      `Find the host-app source that implements this exact requested placement/action: ${placement}`,
      'Preserve every existing host-app feedback form, button, screen, handler, destination, and side effect. Do not replace, remove, repurpose, or reroute existing feedback behavior.',
      'Ensure Paydirt is installed and configured. If it is not, use paydirt_begin_setup and paydirt_finish_setup, then perform every returned installation action first.',
      `Edit the host app so this exact statement runs at the requested trigger: ${presentationStatement}`,
      triggerInstruction(trigger, placement),
      slackRequired
        ? 'Connect Slack if needed, resolve the requested channel, assign it to this form, and verify the form has a Slack channel ID.'
        : 'Use the delivery preference already selected during browser onboarding. Do not ask again unless the developer requests a change.',
      'Resolve dependencies and build the real host-app target. Do not report completion from a snippet or remote-form creation alone.',
      slackRequired
        ? 'Test the requested placement/action, submit a response, and verify one Slack message contains the raw question and exact answer.'
        : 'Test the requested placement/action and leave the form visible without submitting it for the developer.',
      'Report the host files changed, form ID, placement wired, selected delivery route, build command/result, and exact manual test path.',
    ],
    completion_requirements: {
      host_app_edited: true,
      exact_placement_wired: true,
      slack_channel_assigned_when_selected: slackRequired,
      host_app_build_passed: true,
      placement_test_path_reported: true,
    },
  };
}
