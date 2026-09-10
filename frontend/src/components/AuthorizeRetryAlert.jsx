import React from "react";
import { Alert, Button, Link, SpaceBetween } from "@cloudscape-design/components";
import { splitAroundUrl } from "../utils/awsRequestUtils";

// The Cloudscape twin of components/ApiErrorAlert.jsx.
//
// Same affordance, deliberately a second implementation: ApiErrorAlert is
// Bootstrap (S3 World, Sandbox), and a Bootstrap alert dropped into a Cloudscape
// form reads as a defect. What both must guarantee is the pair of behaviours that
// make an expired SSO session recoverable:
//
//   * The verification URL is a real link. The backend's message ends with
//     "…approve this SSO session at <url>, then come back and retry" — printed as
//     plain text that is an instruction the user cannot follow without selecting
//     and copying it by hand.
//   * Retry re-runs *the operation that failed*, not the page. Reloading a profile
//     form would discard everything typed into it, so every caller passes the
//     closure for its own failed call.
//
// `error` is the shape utils/awsRequestUtils.describeError() returns.
function AuthorizeRetryAlert({ error, onRetry, retryLabel = "Retry", header, type = "error" }) {
  if (!error) {
    return null;
  }
  const [before, url, after] = splitAroundUrl(error.message, error.url);

  const actions = (
    <SpaceBetween direction="horizontal" size="xs">
      {error.authUrl && (
        <Button
          iconName="external"
          iconAlign="right"
          onClick={() => window.open(error.authUrl, "_blank", "noopener,noreferrer")}
        >
          Authorize
        </Button>
      )}
      {onRetry && (
        <Button iconName="refresh" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </SpaceBetween>
  );

  return (
    <Alert
      type={type}
      header={header}
      action={error.authUrl || onRetry ? actions : undefined}
    >
      {before}
      {url && (
        <Link href={url} external externalIconAriaLabel="Opens in a new tab" target="_blank">
          {url}
        </Link>
      )}
      {after}
    </Alert>
  );
}

export default AuthorizeRetryAlert;
