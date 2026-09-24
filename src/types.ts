export interface ConferenceWithSendRequest {
  sendRequest: (opt: {
    path: string
    method: 'GET' | 'POST'
    payload?: Record<string, unknown>
  }) => Promise<{ status: number; data: unknown } | undefined>
}
