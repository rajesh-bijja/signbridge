import React from 'react'
import PresignDashboard from '../components/PresignDashboard.jsx'

export default function DashboardPage() {
  // The chat copilot lives on its own dedicated /chat page, so the dashboard is
  // full-width and focused solely on presign/invoke.
  return <PresignDashboard />
}
