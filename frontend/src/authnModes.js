/**
 * The authentication mechanisms a profile can offer — the frontend mirror of
 * lib/authnModes.js.
 *
 * This existed as three separate copies (`const AWS_MODES = ['iam_user',
 * 'sso_user']` in SandboxIde, S3WorldPage and, implicitly, the dashboard), which
 * is exactly why adding EC2 and IRSA meant hunting for every list that had to
 * grow. There is one list now: a profile type that appears here appears in every
 * picker, and a mechanism missing a label fails loudly in the UI rather than
 * rendering a raw `ec2_instance`.
 *
 * Order matters and matches the backend: it is the order pickers render in, and
 * the backend falls back to the first AWS mechanism a profile supports.
 */

export const AWS_MODES = ['sso_user', 'iam_user', 'ec2_instance', 'irsa']

export const REST_MODES = ['rest_basic_auth', 'rest_bearer_token', 'generic']

export const ALL_MODES = [...AWS_MODES, ...REST_MODES]

/** Long labels — forms and dropdowns with room. */
export const AUTHN_LABELS = {
  sso_user: 'AWS SSO / IAM Identity Center',
  iam_user: 'AWS IAM User',
  ec2_instance: 'AWS EC2 Instance Role',
  irsa: 'AWS IRSA (EKS Service Account)',
  rest_basic_auth: 'Basic Auth',
  rest_bearer_token: 'Bearer Token',
  generic: 'Generic REST (no signing)'
}

/** Short labels — buttons and chips, where the "AWS" prefix is already implied. */
export const AUTHN_SHORT_LABELS = {
  sso_user: 'SSO / Identity Center',
  iam_user: 'IAM User',
  ec2_instance: 'EC2 Instance Role',
  irsa: 'IRSA (EKS)',
  rest_basic_auth: 'Basic Auth',
  rest_bearer_token: 'Bearer Token',
  generic: 'Generic'
}

export const isAwsMode = mode => AWS_MODES.includes(String(mode || '').toLowerCase())

export const authnLabel = mode => AUTHN_LABELS[mode] || mode

export const authnShortLabel = mode => AUTHN_SHORT_LABELS[mode] || mode

/** A profile's AWS mechanisms, in the canonical order. */
export const awsModesOf = profile => {
  const supported = (profile && profile.supportedAuthnMechanisms) || []
  return AWS_MODES.filter(mode => supported.includes(mode))
}
