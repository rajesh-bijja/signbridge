import { useSearchParams } from 'react-router-dom'
import { Alert, Badge } from 'react-bootstrap'

import { ObjectViewerBody } from '../components/s3/S3ObjectViewer.jsx'

/**
 * The standalone object viewer at /s3world/object.
 *
 * "Open in new tab" for an image or a PDF is just a presigned S3 URL. For
 * everything else — parquet, xlsx, gzipped NDJSON, a tarball listing — there is
 * no URL a browser could render, so this page is the tab: the object is decoded
 * on the server and rendered here, which means every content type gets a real
 * tab with a real, shareable address instead of a second modal.
 */
export default function S3ObjectPage() {
  const [searchParams] = useSearchParams()
  const profileName = searchParams.get('profileName') || ''
  const authnMode = searchParams.get('authnMode') || ''
  const bucket = searchParams.get('bucket') || ''
  const objectKey = searchParams.get('key') || ''
  const versionId = searchParams.get('versionId') || null

  if (!profileName || !bucket || !objectKey) {
    return (
      <Alert variant="warning" className="mt-3">
        This viewer needs <span className="font-monospace">profileName</span>,{' '}
        <span className="font-monospace">bucket</span> and{' '}
        <span className="font-monospace">key</span> in the URL. Open an object from S3 World rather
        than editing the address.
      </Alert>
    )
  }

  return (
    <div className="pb-4">
      <div className="d-flex flex-wrap align-items-baseline gap-2 mb-3">
        <h5 className="mb-0 font-monospace text-break">
          <span className="text-muted">{bucket}/</span>
          {objectKey}
        </h5>
        <Badge bg="secondary-subtle" text="secondary-emphasis" className="border fw-normal">
          {profileName}
        </Badge>
      </div>
      <ObjectViewerBody
        standalone
        profileName={profileName}
        authnMode={authnMode}
        bucket={bucket}
        objectKey={objectKey}
        versionId={versionId}
      />
    </div>
  )
}
