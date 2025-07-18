"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { useParams, useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { ArrowLeft, Terminal, GitPullRequest } from "lucide-react"
import Link from "next/link"
import { WebSocketClient, useAuthenticatedApiClient } from "@/lib/api"
import { Session, Turn, Run, AgentOutput } from "@/lib/types"
import { useAuthenticatedWebSocket } from "@/lib/api"
import { useAuth } from "@/lib/auth-context"
import { DebugWindow } from "@/components/debug-window"
import { DiffViewer } from "@/diffs/DiffViewer"
import type { DiffData } from "@/diffs/data"

export default function RunPage() {
  const params = useParams()
  const router = useRouter()
  const sessionId = params.id as string
  const turnId = params.turnId as string
  const runId = params.runId as string
  
  // Get authenticated API and WebSocket clients
  const apiClient = useAuthenticatedApiClient()
  const { createWebSocketClient } = useAuthenticatedWebSocket('ws://localhost:8000')
  
  // Debug: Check if we have auth
  const { apiKey, loading: authLoading } = useAuth()
  useEffect(() => {
    console.log('Run page - API key available:', !!apiKey, 'Auth loading:', authLoading)
  }, [apiKey, authLoading])

  // State management
  const [session, setSession] = useState<Session | null>(null)
  const [turn, setTurn] = useState<Turn | null>(null)
  const [run, setRun] = useState<Run | null>(null)
  const [outputs, setOutputs] = useState<AgentOutput[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [wsClient, setWsClient] = useState<WebSocketClient | null>(null)
  const [showSystemDebug, setShowSystemDebug] = useState(false)
  const [diffDataByVariation, setDiffDataByVariation] = useState<Map<number, DiffData[]>>(new Map())
  const [diffsReady, setDiffsReady] = useState<Record<number, boolean>>({})
  const messageIdCounter = useRef(0)
  const seenMessageIds = useRef(new Set<string>())
  
  // Ref for auto-scrolling
  const outputsEndRef = useRef<HTMLDivElement>(null)

  // Load data on mount when authenticated
  useEffect(() => {
    if (sessionId && turnId && runId && apiKey) {
      loadRunData()
    }
  }, [sessionId, turnId, runId, apiKey])

  // Cleanup WebSocket on unmount
  useEffect(() => {
    return () => {
      if (wsClient) {
        wsClient.close()
      }
    }
  }, [wsClient])

  const loadRunData = useCallback(async () => {
    try {
      setIsLoading(true)
      const [sessionResponse, turnResponse, runResponse] = await Promise.all([
        apiClient.getSession(sessionId),
        apiClient.getTurn(sessionId, turnId),
        apiClient.getRun(runId),
      ])
      setSession(sessionResponse)
      setTurn(turnResponse)
      setRun(runResponse)
      setError(null)
      
      // Load existing outputs and diffs after run data is loaded
      if (runResponse.variations > 0) {
        // Load outputs for all variations
        loadExistingOutputs()
        
        // Attempt to load diffs for all variations (silently fail if not ready)
        loadExistingDiffs(runResponse.variations)
      }
    } catch (err) {
      console.error('Failed to load run data:', err)
      setError('Failed to load run data')
    } finally {
      setIsLoading(false)
    }
  }, [sessionId, turnId, runId, apiClient])

  const loadExistingOutputs = useCallback(async () => {
    try {
      // Fetch all outputs from the database
      const outputs = await apiClient.getRunOutputs(runId, { output_type: 'llm' })
      
      // Clear seen message IDs and add existing outputs
      seenMessageIds.current.clear()
      const formattedOutputs = outputs.map((output, index) => {
        const messageId = `existing-${output.id || index}`
        seenMessageIds.current.add(messageId)
        return {
          ...output,
          id: output.id || messageIdCounter.current++
        }
      })
      
      setOutputs(formattedOutputs)
      console.log(`Loaded ${outputs.length} existing outputs from database`)
    } catch (err) {
      // Don't show error if outputs aren't ready yet
      console.log('Could not load existing outputs (may not be ready yet):', err)
    }
  }, [apiClient, runId])

  const loadExistingDiffs = useCallback(async (variationCount: number) => {
    try {
      // Try to fetch diffs for each variation
      const diffPromises = Array.from({ length: variationCount }, async (_, i) => {
        try {
          const diffs = await apiClient.getRunDiffs(runId, { variation_id: i })
          if (diffs.length > 0) {
            // Mark as ready if we got diffs
            setDiffsReady(prev => ({ ...prev, [i]: true }))
            return { variation: i, diffs }
          }
        } catch {
          // Silently ignore - diffs may not be ready yet
          console.log(`Diffs not ready for variation ${i}`)
        }
        return { variation: i, diffs: [] }
      })
      
      const results = await Promise.all(diffPromises)
      
      // Process any diffs that were available
      const newDiffMap = new Map<number, DiffData[]>()
      results.forEach(({ variation, diffs }) => {
        if (diffs && diffs.length > 0) {
          const diffData: DiffData[] = diffs.map(diff => ({
            oldFile: {
              fileName: diff.oldFile.name,
              content: diff.oldFile.content
            },
            newFile: {
              fileName: diff.newFile.name,
              content: diff.newFile.content
            }
          }))
          newDiffMap.set(variation, diffData)
        }
      })
      
      if (newDiffMap.size > 0) {
        setDiffDataByVariation(newDiffMap)
        console.log(`Loaded diffs for ${newDiffMap.size} variations`)
      }
    } catch (err) {
      // Don't show error - diffs may not be ready
      console.log('Could not load existing diffs:', err)
    }
  }, [apiClient, runId])

  const fetchDiffsForVariation = useCallback(async (variationId: number) => {
    try {
      const diffs = await apiClient.getRunDiffs(runId, { variation_id: variationId })
      
      if (diffs.length > 0) {
        const diffData: DiffData[] = diffs.map(diff => ({
          oldFile: {
            fileName: diff.oldFile.name,
            content: diff.oldFile.content
          },
          newFile: {
            fileName: diff.newFile.name,
            content: diff.newFile.content
          }
        }))
        
        setDiffDataByVariation(prev => {
          const newMap = new Map(prev)
          newMap.set(variationId, diffData)
          return newMap
        })
      }
    } catch (err) {
      console.error(`Failed to fetch diffs for variation ${variationId}:`, err)
    }
  }, [runId, apiClient])


  const startWebSocketConnection = useCallback(() => {
    try {
      // Close existing connection if any
      if (wsClient) {
        wsClient.close()
        setWsClient(null)
        setIsStreaming(false)
      }
      
      // Clear seen message IDs for fresh start
      seenMessageIds.current.clear()
      
      const wsUrl = `ws://localhost:8000/api/v1/ws/runs/${runId}`
      const client = createWebSocketClient(wsUrl)
      client.connect({
        onMessage: (message) => {
          // Handle incoming WebSocket messages
          // Accept LLM output messages
          if (message.type === "llm") {
            // Generate or use existing message ID
            const messageId = message.message_id || `msg-${Date.now()}-${Math.random()}`
            
            // Skip if we've already processed this message
            if (seenMessageIds.current.has(messageId)) {
              console.log('Skipping duplicate message:', messageId)
              return
            }
            seenMessageIds.current.add(messageId)
            
            const newOutput: AgentOutput = {
              id: messageIdCounter.current++,
              run_id: runId,
              variation_id: parseInt(message.data.variation_id) ?? 0,
              content: message.data.content || "",
              timestamp: message.data.timestamp,
              output_type: message.type,
            }
            setOutputs(prev => [...prev, newOutput])
          }
          
          // Handle status messages for diffs
          if (message.type === "status" && message.data.status === "diffs_ready") {
            const variationId = message.data.metadata?.variation_id
            if (variationId !== undefined) {
              setDiffsReady(prev => ({ ...prev, [variationId]: true }))
              console.log(`Diffs ready for variation ${variationId}`)
              
              // Auto-fetch diffs when ready
              fetchDiffsForVariation(variationId)
            }
          }
        },
        onError: (error) => {
          console.error('WebSocket error:', error)
          setIsStreaming(false)
        },
        onClose: () => {
          setIsStreaming(false)
        }
      })
      setWsClient(client)
      setIsStreaming(true)
    } catch (err) {
      console.error('Failed to start WebSocket connection:', err)
    }
  }, [wsClient, createWebSocketClient, runId, messageIdCounter, seenMessageIds, fetchDiffsForVariation])

  // Auto-start streaming when run data is loaded
  useEffect(() => {
    if (run && (run.status === 'running' || run.status === 'pending') && !wsClient) {
      startWebSocketConnection()
    }
  }, [run, wsClient, startWebSocketConnection])
  
  // Auto-scroll to bottom when new outputs arrive
  useEffect(() => {
    if (outputsEndRef.current) {
      outputsEndRef.current.scrollIntoView({ behavior: "smooth" })
    }
  }, [outputs])


  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed":
        return "default"
      case "failed":
        return "destructive"
      case "running":
        return "secondary"
      default:
        return "outline"
    }
  }


  if (authLoading || isLoading) {
    return (
      <div className="bg-gray-950 text-gray-50 min-h-screen">
        <div className="container mx-auto max-w-6xl py-8">
          <div className="flex items-center justify-center py-20">
            <div className="animate-pulse">{authLoading ? 'Authenticating...' : 'Loading run...'}</div>
          </div>
        </div>
      </div>
    )
  }

  if (error || !session || !turn || !run) {
    return (
      <div className="bg-gray-950 text-gray-50 min-h-screen">
        <div className="container mx-auto max-w-6xl py-8">
          <div className="text-center py-20">
            <p className="text-red-400 mb-4">{error || 'Run not found'}</p>
            <Button onClick={() => router.push(`/session/${sessionId}/turn/${turnId}`)} variant="outline">
              Back to Turn
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="bg-gray-950 text-gray-50 min-h-screen pb-32">
        <div className="container mx-auto max-w-6xl py-8">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.push(`/session/${sessionId}/turn/${turnId}`)}
            className="text-gray-400 hover:text-gray-200"
          >
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1 text-sm">
              <Link href={`/session/${sessionId}`} className="text-gray-400 hover:text-gray-200">
                {session.title}
              </Link>
              <span className="text-gray-600">/</span>
              <Link href={`/session/${sessionId}/turn/${turnId}`} className="text-gray-400 hover:text-gray-200">
                Turn {turn.turn_number}
              </Link>
              <span className="text-gray-600">/</span>
              <span className="text-gray-300">Run</span>
            </div>
            <h1 className="text-2xl font-semibold">Run Details</h1>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={getStatusColor(run.status) as 'default' | 'secondary' | 'destructive' | 'outline'}>
              {run.status}
            </Badge>
            {run.winning_variation_id && (
              <Badge variant="default" className="bg-green-600">
                Winner: Variation {run.winning_variation_id}
              </Badge>
            )}
          </div>
        </div>


        <Tabs defaultValue="variation-0" className="w-full">
          <div className="flex items-center justify-between mb-4">
            <TabsList className="bg-gray-900/50 border border-gray-800">
              {Array.from({ length: run.variations }, (_, i) => i).map((variation) => (
                <TabsTrigger key={variation} value={`variation-${variation}`}>
                  Model {variation + 1}
                </TabsTrigger>
              ))}
              <TabsTrigger value="results">Results</TabsTrigger>
              <TabsTrigger value="config">Configuration</TabsTrigger>
            </TabsList>
            
            <div className="flex items-center gap-2">
              {process.env.NODE_ENV === 'development' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowSystemDebug(!showSystemDebug)}
                  className="gap-2"
                >
                  <Terminal className="w-4 h-4" />
                  System Debug
                </Button>
              )}
            </div>
          </div>

          {Array.from({ length: run.variations }, (_, i) => i).map((variation) => (
            <TabsContent key={variation} value={`variation-${variation}`} className="space-y-4">
              <div className="bg-gray-900/30 border border-gray-800 rounded-lg">
                <div className="p-4 border-b border-gray-800 flex items-center justify-between">
                  <h3 className="font-medium">Model {variation + 1} Output</h3>
                  <div className="flex items-center gap-2">
                    {isStreaming && (
                      <div className="flex items-center gap-2 text-sm text-green-400">
                        <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
                        Live
                      </div>
                    )}
                    <Badge variant="outline" className="text-xs">
                      {outputs.filter(o => o.variation_id === variation).length} messages
                    </Badge>
                  </div>
                </div>
                
                <div className="max-h-[600px] overflow-y-auto p-4 bg-gray-950 rounded font-mono text-sm">
                  {outputs.filter(o => o.variation_id === variation).length === 0 ? (
                    <div className="text-center py-8 text-gray-400">
                      {run.status === "pending" ? "Waiting for run to start..." : "No output yet"}
                    </div>
                  ) : (
                    <div className="space-y-0.5">
                      {outputs
                        .filter(o => o.variation_id === variation)
                        .map((output) => {
                          // Only showing LLM output now
                          return (
                            <div key={output.id} className="text-green-400 whitespace-pre-wrap">
                              {output.content}
                            </div>
                          );
                        })}
                    </div>
                  )}
                  <div ref={outputsEndRef} />
                </div>
              </div>
              
              {/* Diff Viewer Section */}
              {diffsReady[variation] && (
                <div className="bg-gray-900/30 border border-gray-800 rounded-lg mt-4">
                  <div className="p-4 border-b border-gray-800 flex items-center justify-between">
                    <h3 className="font-medium">Code Changes</h3>
                    <button
                      onClick={() => {
                        // TODO: Implement PR creation logic
                        console.log('Create PR clicked for variation:', variation);
                      }}
                      className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/80 rounded-md transition-colors"
                    >
                      <GitPullRequest className="h-4 w-4" />
                      Create Pull Request
                    </button>
                  </div>
                  <div className="p-4">
                    {diffDataByVariation.get(variation) && diffDataByVariation.get(variation)!.length > 0 ? (
                      <DiffViewer 
                        data={diffDataByVariation.get(variation)}
                        options={{
                          mode: "unified",
                          theme: "dark",
                          wrap: true,
                          highlight: true,
                          fontSize: 12
                        }}
                      />
                    ) : (
                      <div className="text-center py-8 text-gray-400">
                        <div className="animate-pulse">Loading code changes...</div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </TabsContent>
          ))}

          <TabsContent value="results" className="space-y-4">
            <div className="bg-gray-900/30 border border-gray-800 rounded-lg p-6">
              <h3 className="text-lg font-medium mb-4">Run Results</h3>
              {Object.keys(run.results || {}).length === 0 ? (
                <p className="text-gray-400">No results available yet.</p>
              ) : (
                <pre className="text-sm bg-gray-950 p-4 rounded border border-gray-800 overflow-x-auto">
                  {JSON.stringify(run.results, null, 2)}
                </pre>
              )}
            </div>
          </TabsContent>

          <TabsContent value="config" className="space-y-4">
            <div className="bg-gray-900/30 border border-gray-800 rounded-lg p-6">
              <h3 className="text-lg font-medium mb-4">Agent Configuration</h3>
              <pre className="text-sm bg-gray-950 p-4 rounded border border-gray-800 overflow-x-auto">
                {JSON.stringify(run.agent_config, null, 2)}
              </pre>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
    
    {run && (
      <DebugWindow 
        runId={runId}
        variations={run.variations}
        isOpen={showSystemDebug} 
        onClose={() => setShowSystemDebug(false)} 
      />
    )}
    
    {/* Floating Input Area */}
    <div className="fixed bottom-0 left-0 right-0 z-50 p-4 bg-gray-950/95 backdrop-blur-sm border-t border-gray-800">
      <div className="container mx-auto max-w-4xl">
        <input
          type="text"
          placeholder="Request changes or ask a question"
          className="w-full px-4 py-3 bg-gray-900 border border-gray-700 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.currentTarget.value.trim()) {
              // TODO: Handle submit
              console.log('Submit:', e.currentTarget.value);
              e.currentTarget.value = '';
            }
          }}
        />
      </div>
    </div>
    </>
  )
}