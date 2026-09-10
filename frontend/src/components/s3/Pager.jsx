import { Button, Form } from 'react-bootstrap'

/**
 * Pager — the Previous/Next control for the bucket list and the object browser.
 *
 * It exists as its own component for one reason: it is rendered TWICE on each of
 * those screens, above the table and below it. A page of 1000 objects is several
 * screens tall, and having to scroll to the bottom to reach Next — then back to
 * the top to see what arrived — is the kind of small friction that makes a tool
 * annoying to use. Two identical controls, one always in view.
 *
 * The page-size selector belongs to only one of the two (the caller passes
 * `pageSizes` for the bottom instance), because two selects bound to the same
 * value on one screen reads as a bug even when it behaves correctly.
 */
export default function Pager({
  summary,
  onPrevious,
  onNext,
  disablePrevious,
  disableNext,
  pageSize,
  pageSizes,
  onPageSize,
  className = ''
}) {
  return (
    <div className={`d-flex flex-wrap align-items-center gap-2 ${className}`}>
      {pageSizes && (
        <Form.Select
          size="sm"
          style={{ width: 150 }}
          value={pageSize}
          onChange={event => onPageSize(Number(event.target.value))}
          aria-label="Rows per page"
        >
          {pageSizes.map(size => (
            <option key={size} value={size}>
              {size} per page
            </option>
          ))}
        </Form.Select>
      )}
      {summary && <span className="small text-muted">{summary}</span>}
      <div className="ms-auto d-flex gap-2">
        <Button size="sm" variant="outline-secondary" disabled={disablePrevious} onClick={onPrevious}>
          ‹ Previous
        </Button>
        <Button size="sm" variant="outline-secondary" disabled={disableNext} onClick={onNext}>
          Next ›
        </Button>
      </div>
    </div>
  )
}
