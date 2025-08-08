const { InstanceBase, InstanceStatus, Regex, runEntrypoint } = require('@companion-module/base')
const net = require('net')

// ---------- helpers ----------
function pad3(n) {
  return String(n).padStart(3, '0')
}

/** ETL checksum includes braces and everything except the checksum char */
function etlChecksumForPacket(packetWithoutChecksum) {
  const sum = [...packetWithoutChecksum].reduce((a, c) => a + (c.charCodeAt(0) - 32), 0)
  return String.fromCharCode((sum % 95) + 32)
}

/** Build full packet and append checksum. CRLF gets added on send. */
function pkt(body) {
  const payload = `{${body}}`
  const csum = etlChecksumForPacket(payload)
  return payload + csum
}

/** One shot TCP helper. Connect, send, collect briefly, close. */
function tcpRequest({ host, port, message, inactivityMs = 200, overallTimeoutMs = 1500, logger = () => {} }) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket()
    let chunks = []
    let gotAny = false
    let inactivityTimer = null
    const overallTimer = setTimeout(() => {
      cleanup()
      reject(new Error('TCP overall timeout'))
    }, overallTimeoutMs)

    function cleanup() {
      try { client.destroy() } catch {}
      if (inactivityTimer) clearTimeout(inactivityTimer)
      clearTimeout(overallTimer)
    }

    function armInactivity() {
      if (inactivityTimer) clearTimeout(inactivityTimer)
      inactivityTimer = setTimeout(() => {
        const data = Buffer.concat(chunks).toString('ascii')
        cleanup()
        resolve(data)
      }, inactivityMs)
    }

    client.setNoDelay(true)

    client.on('error', (err) => {
      cleanup()
      reject(err)
    })

    client.on('data', (buf) => {
      chunks.push(buf)
      gotAny = true
      armInactivity()
    })

    client.on('close', () => {
      if (gotAny) {
        const data = Buffer.concat(chunks).toString('ascii')
        cleanup()
        resolve(data)
      } else {
        cleanup()
        resolve('')
      }
    })

    client.connect(port, host, () => {
      logger(`TX: ${JSON.stringify(message)}`)
      client.write(message, 'ascii')
      armInactivity()
    })
  })
}

// ---------- instance ----------
class VictorInstance extends InstanceBase {
  async init(config) {
    this.config = config

    // alias state
    this.aliasTimer = null
    this.aliasVarDefsReady = false
    this.outputsCount = 0
    this.inputsCount = 0
    this.outputAliases = []
    this.inputAliases = []

    // status state
    this.statusTimer = null
    this.statusCountsReady = false

    this.updateStatus(InstanceStatus.Unknown)
    this.rebuildVariableDefinitions()
    this.initActions()
    this.startAliasPolling()
    this.startStatusPolling()

    this.log('info', 'Victor ready. Test Connect to verify. Aliases and routing status will auto update.')
  }

  // ---------- variable definitions ----------
  rebuildVariableDefinitions() {
    const defs = [
      { variableId: 'last_reply', name: 'Last raw reply' },
      { variableId: 'last_error', name: 'Last error message' },
      { variableId: 'last_alias_dump', name: 'Last alias raw dump' },
      { variableId: 'last_status_raw', name: 'Last full status raw' },

      { variableId: 'psu1_ok', name: 'PSU1 OK (O/F)' },
      { variableId: 'psu2_ok', name: 'PSU2 OK (O/F)' },
      { variableId: 'link_ok', name: 'Interlink OK (O/F)' },
      { variableId: 'summary_alarm_ok', name: 'Summary alarm OK (O/F)' }
    ]

    // Alias name variables
    for (let o = 1; o <= (this.outputsCount || 0); o++) {
      defs.push({ variableId: `output_${pad3(o)}_name`, name: `Output ${pad3(o)} name` })
    }
    for (let i = 1; i <= (this.inputsCount || 0); i++) {
      defs.push({ variableId: `input_${pad3(i)}_name`, name: `Input ${pad3(i)} name` })
    }

    // Routing source per output
    for (let o = 1; o <= (this.outputsCount || 0); o++) {
      defs.push({ variableId: `out_${pad3(o)}_src`, name: `Output ${pad3(o)} source (input number)` })
    }

    this.setVariableDefinitions(defs)
  }

  // ---------- dropdown choices built from aliases ----------
  getInputChoices() {
    if (this.inputAliases?.length) {
      return this.inputAliases.map((label, i) => ({
        id: String(i + 1),
        label: `${pad3(i + 1)}  ${label}`
      }))
    }
    const n = Math.max(1, this.inputsCount || 16)
    return Array.from({ length: n }, (_, i) => {
      const idx = i + 1
      return { id: String(idx), label: pad3(idx) }
    })
  }

  getOutputChoices() {
    if (this.outputAliases?.length) {
      return this.outputAliases.map((label, i) => ({
        id: String(i + 1),
        label: `${pad3(i + 1)}  ${label}`
      }))
    }
    const n = Math.max(1, this.outputsCount || 16)
    return Array.from({ length: n }, (_, i) => {
      const idx = i + 1
      return { id: String(idx), label: pad3(idx) }
    })
  }

  // ---------- actions ----------
  initActions() {
    this.setActionDefinitions({
      test_connect: {
        name: 'Test Connect (send AB?)',
        options: [],
        callback: async () => {
          try {
            const body = `${this.dstAddr()}${this.srcAddr()}?`  // AB?
            const msg = pkt(body) + '\r\n'
            const reply = await tcpRequest({
              host: this.host(),
              port: this.port(),
              message: msg,
              logger: (s) => this.log('debug', s)
            })
            this.log('debug', `RX: ${reply}`)
            this.setVariableValues({ last_reply: reply || '(no data)', last_error: '' })
            this.updateStatus(InstanceStatus.Ok)
          } catch (e) {
            this.updateStatus(InstanceStatus.ConnectionFailure, e?.message || 'connect failed')
            this.setVariableValues({ last_error: e?.message || String(e) })
            this.log('error', `Test Connect failed: ${e?.message || e}`)
          }
        }
      },

      read_full_status: {
        name: 'Read Full Status (?)',
        options: [],
        callback: async () => {
          await this.pollStatusOnce()
        }
      },

      read_quick_status: {
        name: 'Read Quick Status (Q)',
        options: [],
        callback: async () => {
          await this.pollQuickStatusOnce()
        }
      },

      // Route with dropdowns that accept custom input or variables
      route: {
        name: 'Route input to output (short switch s)',
        options: [
          {
            id: 'input',
            type: 'dropdown',
            label: 'Input',
            choices: this.getInputChoices(),
            allowCustom: true,
            default: '1'
          },
          {
            id: 'output',
            type: 'dropdown',
            label: 'Output',
            choices: this.getOutputChoices(),
            allowCustom: true,
            default: '1'
          }
        ],
        callback: async ({ options }) => {
          const inStr = await this.parseVariablesInString(String(options.input ?? ''))
          const outStr = await this.parseVariablesInString(String(options.output ?? ''))

          const iNum = Number(inStr.trim())
          const oNum = Number(outStr.trim())

          const maxIn = this.inputAliases?.length || this.inputsCount || 16
          const maxOut = this.outputAliases?.length || this.outputsCount || 16

          if (!Number.isFinite(iNum) || iNum < 0 || iNum > Math.max(999, maxIn)) {
            this.log('error', `Input must be a number 0..${maxIn}. Got "${inStr}"`)
            return
          }
          if (!Number.isFinite(oNum) || oNum < 1 || oNum > Math.max(999, maxOut)) {
            this.log('error', `Output must be a number 1..${maxOut}. Got "${outStr}"`)
            return
          }

          const i = pad3(iNum)
          const o = pad3(oNum)
          const DA = this.dstAddr()
          const SA = this.srcAddr()
          const body = `${DA}${SA}s,${o},${i}`  // distributive OOO,III
          await this.sendBody(body)
        }
      },

      poll_aliases_now: {
        name: 'Poll Aliases Now',
        options: [],
        callback: async () => {
          await this.pollAliasesOnce()
        }
      },

      poll_status_now: {
        name: 'Poll Status Now',
        options: [],
        callback: async () => {
          await this.pollStatusOnce()
        }
      }
    })
  }

  // ---------- alias polling ----------
  startAliasPolling() {
    this.stopAliasPolling()
    const interval = Math.max(500, Number(this.config.aliasPollMs || 5000))
    this.aliasTimer = setInterval(() => {
      this.pollAliasesOnce().catch((e) => {
        this.log('debug', `Alias poll error: ${e?.message || e}`)
      })
    }, interval)
  }

  stopAliasPolling() {
    if (this.aliasTimer) {
      clearInterval(this.aliasTimer)
      this.aliasTimer = null
    }
  }

  parseAliasDump(reply) {
    // Example:
    // {BAT?,C1-1,...,C4-4,ANT1,...,AN16}g
    const start = reply.indexOf('{')
    const end = reply.lastIndexOf('}')
    if (start < 0 || end < 0 || end <= start) return null

    const inner = reply.slice(start + 1, end)
    const parts = inner.split(',')
    if (parts.length < 2) return null

    const header = parts[0]
    if (!header.endsWith('T?')) return null

    const tokens = parts.slice(1)
    if (tokens.length % 2 !== 0 || tokens.length === 0) return null

    const half = tokens.length / 2
    const outAliases = tokens.slice(0, half)
    const inAliases = tokens.slice(half)

    return { outAliases, inAliases }
  }

  async pollAliasesOnce() {
    const body = `${this.dstAddr()}${this.srcAddr()}T?`
    const msg = pkt(body) + '\r\n'
    const reply = await tcpRequest({
      host: this.host(),
      port: this.port(),
      message: msg,
      logger: (s) => this.log('debug', s)
    })
    if (!reply) return

    this.setVariableValues({ last_alias_dump: reply, last_error: '' })
    this.log('debug', `Alias dump RX: ${reply}`)

    const parsed = this.parseAliasDump(reply)
    if (!parsed) return

    const { outAliases, inAliases } = parsed

    // Save for dropdowns and variables
    this.outputAliases = outAliases
    this.inputAliases = inAliases

    // Update sizes if changed and rebuild defs
    const changed = (outAliases.length !== this.outputsCount) || (inAliases.length !== this.inputsCount)
    this.outputsCount = outAliases.length
    this.inputsCount = inAliases.length
    if (changed) this.rebuildVariableDefinitions()

    // Set alias name values
    const vals = {}
    outAliases.forEach((name, idx) => (vals[`output_${pad3(idx + 1)}_name`] = name))
    inAliases.forEach((name, idx) => (vals[`input_${pad3(idx + 1)}_name`] = name))
    this.setVariableValues(vals)

    // Refresh actions so dropdowns show latest names
    this.initActions()
  }

  // ---------- status polling ----------
  startStatusPolling() {
    this.stopStatusPolling()
    const interval = Math.max(200, Number(this.config.statusPollMs || 750))
    this.statusTimer = setInterval(() => {
      this.pollStatusOnce().catch((e) => {
        this.log('debug', `Status poll error: ${e?.message || e}`)
      })
    }, interval)
  }

  stopStatusPolling() {
    if (this.statusTimer) {
      clearInterval(this.statusTimer)
      this.statusTimer = null
    }
  }

  parseFullStatus(reply) {
    // Example:
    // {BASTATUS,000,002,003,...,016,O,F,O,F}<csum>
    const start = reply.indexOf('{')
    const end = reply.lastIndexOf('}')
    if (start < 0 || end < 0 || end <= start) return null

    const inner = reply.slice(start + 1, end)
    const parts = inner.split(',')
    if (parts.length < 2) return null

    const header = parts[0] // should contain "STATUS"
    if (!header.includes('STATUS')) return null

    // last 4 tokens are flags
    if (parts.length < 6) return null
    const flags = parts.slice(-4)
    const nums = parts.slice(1, -4)

    // nums are 3-digit strings. On distributive, each is the input number for output index
    const sources = nums.map((n) => {
      const v = parseInt(n, 10)
      return isNaN(v) ? 0 : v
    })

    return {
      sources,
      flags // [psu1, psu2, link, summary]
    }
  }

  async pollStatusOnce() {
    const body = `${this.dstAddr()}${this.srcAddr()}?`
    const msg = pkt(body) + '\r\n'
    const reply = await tcpRequest({
      host: this.host(),
      port: this.port(),
      message: msg,
      logger: (s) => this.log('debug', s)
    })
    if (!reply) return

    this.setVariableValues({ last_status_raw: reply, last_error: '' })
    this.log('debug', `Status RX: ${reply}`)

    const parsed = this.parseFullStatus(reply)
    if (!parsed) return

    const { sources, flags } = parsed
    // If we did not know output count yet, adopt it from status
    if (!this.outputsCount || this.outputsCount !== sources.length) {
      this.outputsCount = sources.length
      // rebuild to ensure out_###_src vars exist
      this.rebuildVariableDefinitions()
    }

    // Update per output source vars
    const vals = {}
    sources.forEach((srcNum, idx) => {
      vals[`out_${pad3(idx + 1)}_src`] = String(srcNum)
    })

    // Update health flags
    const [psu1, psu2, link, summary] = flags
    vals['psu1_ok'] = psu1 || ''
    vals['psu2_ok'] = psu2 || ''
    vals['link_ok'] = link || ''
    // summary flag in the manual is "internal summary alarm". O = OK, F = Fault
    vals['summary_alarm_ok'] = summary || ''

    this.setVariableValues(vals)
  }

  async pollQuickStatusOnce() {
    const body = `${this.dstAddr()}${this.srcAddr()}Q`
    const msg = pkt(body) + '\r\n'
    const reply = await tcpRequest({
      host: this.host(),
      port: this.port(),
      message: msg,
      logger: (s) => this.log('debug', s)
    })
    if (!reply) return

    // Example quick: {BAQOFOF}<csum>
    const start = reply.indexOf('{')
    const end = reply.lastIndexOf('}')
    if (start >= 0 && end > start) {
      const inner = reply.slice(start + 1, end)
      if (inner.length >= 6 && inner[2] === 'Q') {
        const flags = inner.slice(3) // should be 4 chars like O F O F
        const vals = {
          psu1_ok: flags[0] || '',
          psu2_ok: flags[1] || '',
          link_ok: flags[2] || '',
          summary_alarm_ok: flags[3] || ''
        }
        this.setVariableValues(vals)
      }
    }
  }

  // ---------- core send ----------
  async sendBody(body) {
    try {
      const msg = pkt(body) + '\r\n'
      const reply = await tcpRequest({
        host: this.host(),
        port: this.port(),
        message: msg,
        logger: (s) => this.log('debug', s)
      })
      this.log('debug', `RX: ${reply}`)
      this.setVariableValues({ last_reply: reply || '(no data)', last_error: '' })
      this.updateStatus(InstanceStatus.Ok)
    } catch (e) {
      this.updateStatus(InstanceStatus.ConnectionFailure, e?.message || 'send failed')
      this.setVariableValues({ last_error: e?.message || String(e) })
      this.log('error', `Send failed: ${e?.message || e}`)
    }
  }

  // ---------- config ----------
  host() {
    return this.config.host || '192.168.0.252'
  }
  port() {
    return Number(this.config.port) || 4000
  }
  dstAddr() {
    const s = (this.config.dstAddr || 'A').toString()
    return s.length ? s[0] : 'A'
  }
  srcAddr() {
    const s = (this.config.srcAddr || 'B').toString()
    return s.length ? s[0] : 'B'
  }

  getConfigFields() {
    return [
      { type: 'static-text', id: 'info', label: 'Info', value: 'Host and port. Port default is 4000. DA and SA usually A and B.' },
      { type: 'textinput', id: 'host', label: 'Host', width: 6, default: '192.168.0.252', regex: Regex.IP },
      { type: 'number', id: 'port', label: 'Port', width: 6, default: 4000, min: 1, max: 65535 },
      { type: 'textinput', id: 'dstAddr', label: 'Destination address char', width: 3, default: 'A' },
      { type: 'textinput', id: 'srcAddr', label: 'Source address char', width: 3, default: 'B' },
      { type: 'number', id: 'aliasPollMs', label: 'Alias poll interval ms', width: 6, default: 5000, min: 200, max: 60000 },
      { type: 'number', id: 'statusPollMs', label: 'Status poll interval ms', width: 6, default: 750, min: 100, max: 5000 }
    ]
  }

  async configUpdated(config) {
    this.config = config
    this.updateStatus(InstanceStatus.Unknown)
    this.startAliasPolling()
    this.startStatusPolling()
    this.rebuildVariableDefinitions()
    this.initActions()
  }

  async destroy() {
    this.stopAliasPolling()
    this.stopStatusPolling()
  }
}

runEntrypoint(VictorInstance)
