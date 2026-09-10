import SandboxIde from '../components/SandboxIde.jsx'

// Sandbox mode — the third invocation mode, alongside Rest_Api (the dashboard's
// presign/invoke) and Cli (AWS CLI passthrough).
//
// SigV4 request signing is a specialist skill; writing a few lines of boto3 or
// the AWS SDK is not. This page closes that gap: the same profiles and
// credentials the dashboard uses, driven from code, run in a throwaway container
// so nothing has to be installed locally.
export default function SandboxPage() {
  return (
    <div className="pb-4">
      <div className="d-flex align-items-baseline gap-2 mb-3">
        <h4 className="mb-0">Sandbox</h4>
        <span className="text-muted small">
          Write Python, JavaScript, TypeScript, or Java and run it against your selected profile in
          an isolated container.
        </span>
      </div>
      <SandboxIde />
    </div>
  )
}
