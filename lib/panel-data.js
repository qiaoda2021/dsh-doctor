/** Read-only panel transport, owned by Connection's existing authenticated Fetch fence. */
export const PANEL_DATA_PATH = '/api/dsh-doctor/panel'

export function registerPanelData(connection, { refresh, snapshot, ready } = {}) {
  if (typeof connection?.fetch?.register !== 'function') return undefined
  if (typeof refresh !== 'function' || typeof snapshot !== 'function') throw new TypeError('Panel refresh and snapshot are required')
  return connection.fetch.register({
    path: PANEL_DATA_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
      // Defense for direct handler calls only. Real Connection dispatch filters methods
      // first: an authenticated POST falls through to 404, not this 405 branch.
      if (request.method !== 'GET') return Response.json({ pending: true, error: '方法不允许' }, { status: 405, headers })
      if (request.signal.aborted) return Response.json({ pending: true, error: '请求已取消' }, { status: 499, headers })
      try {
        await ready?.()
        if (request.signal.aborted) return Response.json({ pending: true, error: '请求已取消' }, { status: 499, headers })
        await refresh({ force: new URL(request.url).searchParams.get('force') === '1' })
        if (request.signal.aborted) return Response.json({ pending: true, error: '请求已取消' }, { status: 499, headers })
        return Response.json(snapshot(), { headers })
      } catch {
        // No raw exception/stack/config values cross into a browser response.
        return Response.json({ pending: true, error: '体检数据采集失败，请稍后重试。' }, { status: 503, headers })
      }
    },
  })
}
