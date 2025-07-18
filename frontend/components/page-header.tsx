"use client"

import { BrainCircuit, ArrowLeft, Archive, Share, GitPullRequest, FileText } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Button } from "@/components/ui/button"
import { apiClient } from "@/lib/api"
import { Session } from "@/lib/types"
import { useState, useEffect } from "react"
import { AccountDropdown } from "@/components/account-dropdown"

export function PageHeader() {
  const pathname = usePathname()
  const [isPrCreated, setIsPrCreated] = useState(false)
  const [session, setSession] = useState<Session | null>(null)
  
  // Check if we're on a session page
  const sessionMatch = pathname.match(/^\/session\/([^/]+)$/)
  const sessionId = sessionMatch?.[1]
  
  // Check if we're on the settings page
  const isSettingsPage = pathname === '/settings'
  
  // Load session data and reset PR state
  useEffect(() => {
    if (sessionId) {
      loadSession(sessionId)
    } else {
      setSession(null)
      setIsPrCreated(false)
    }
  }, [sessionId])

  const loadSession = async (id: string) => {
    try {
      const sessionData = await apiClient.getSession(id)
      setSession(sessionData)
    } catch (err) {
      console.error('Failed to load session:', err)
      setSession(null)
    }
  }
  
  if (session) {
    // Session page header
    return (
      <header className="flex items-center justify-between px-4 py-2 border-b border-gray-800 bg-gray-950">
        <div className="flex items-center gap-4">
          <Link href="/">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="w-5 h-5" />
            </Button>
          </Link>
          <h1 className="text-lg font-medium text-gray-50">{session.title}</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild className="text-gray-300 hover:text-gray-50">
            <a 
              href={`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'}/docs`}
              target="_blank" 
              rel="noopener noreferrer"
              className="flex items-center gap-2"
            >
              <FileText className="w-4 h-4" />
              API Docs
            </a>
          </Button>
          <Button variant="outline" className="bg-gray-800 border-gray-700">
            <Archive className="w-4 h-4 mr-2" />
            Archive
          </Button>
          <Button variant="outline" className="bg-gray-800 border-gray-700">
            <Share className="w-4 h-4 mr-2" />
            Share
          </Button>
          <Button className="bg-white text-black hover:bg-gray-200" onClick={() => setIsPrCreated(true)}>
            <GitPullRequest className="w-4 h-4 mr-2" />
            {isPrCreated ? "View PR" : "Create PR"}
          </Button>
          <AccountDropdown />
        </div>
      </header>
    )
  }
  
  if (isSettingsPage) {
    // Settings page header
    return (
      <header className="border-b border-gray-800 bg-gray-950">
        <div className="container mx-auto px-4 py-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link href="/">
                <Button variant="ghost" size="icon">
                  <ArrowLeft className="w-5 h-5" />
                </Button>
              </Link>
              <h1 className="text-lg font-medium text-gray-50">Settings</h1>
            </div>
            <AccountDropdown />
          </div>
        </div>
      </header>
    )
  }
  
  // Default header for other pages
  return (
    <header className="border-b border-gray-800 bg-gray-950">
      <div className="container mx-auto px-4 py-4">
        <div className="flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3 w-fit">
            <BrainCircuit className="w-8 h-8 text-gray-300" />
            <span className="text-xl font-semibold text-gray-50">DevSwarm</span>
          </Link>
          <nav className="flex items-center gap-2">
            <Button variant="ghost" size="sm" asChild>
              <a 
                href={`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'}/docs`}
                target="_blank" 
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-gray-300 hover:text-gray-50"
              >
                <FileText className="w-4 h-4" />
                API Docs
              </a>
            </Button>
            <AccountDropdown />
          </nav>
        </div>
      </div>
    </header>
  )
}