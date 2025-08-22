// src/main.js
const { InstanceBase, InstanceStatus, Regex, runEntrypoint } = require('@companion-module/base')
const net = require('net')

// ---------- helpers ----------
function pad3(n) {
	return String(n).padStart(3, '0')
}
function safeInt(v, d = 0) {
	const n = Number(v)
	return Number.isFinite(n) ? n : d
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
			try {
				client.destroy()
			} catch {}
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
class EtlRfMatrixInstance extends InstanceBase {
	async init(config) {
		this.config = config

		// XY selection state
		this.selectedOutput = null // 1-based
		this.currentSources = [] // index o-1 -> input number routed

		// alias and size state
		this.outputAliases = []
		this.inputAliases = []
		this.outputsCount = 0
		this.inputsCount = 0

		// timers
		this.aliasTimer = null
		this.statusTimer = null

		this.updateStatus(InstanceStatus.Unknown)
		this.rebuildVariableDefinitions()
		this.initActions()
		this.initFeedbacks()
		this.buildAndSetPresets()
		this.startAliasPolling()
		this.startStatusPolling()

		// initial polls so UI can reflect reality on boot
		try {
			await this.pollAliasesOnce()
		} catch (e) {
			this.log('debug', `Initial alias poll error: ${e?.message || e}`)
		}
		try {
			await this.pollStatusOnce()
		} catch (e) {
			this.log('debug', `Initial status poll error: ${e?.message || e}`)
		}

		this.log('info', 'Matrix ready. Tap a Destination, then a Source. Aliases and status auto update.')
	}

	// ---------- status helpers ----------
	_markOk(msg = 'poll ok') {
		this.updateStatus(InstanceStatus.Ok)
		this.log('debug', msg)
	}
	_markWarn(msg = 'no data or parse error') {
		this.updateStatus(InstanceStatus.Unknown, msg)
		this.log('debug', msg)
	}
	_markFail(err) {
		const m = err?.message || String(err) || 'poll failed'
		this.updateStatus(InstanceStatus.ConnectionFailure, m)
		this.setVariableValues({ last_error: m })
		this.log('error', m)
	}

	// ---------- configured size helpers ----------
	configuredInputs() {
		const n = Number(this.config?.inputsConfigured)
		return Number.isFinite(n) && n > 0 ? n : 16
	}
	configuredOutputs() {
		const n = Number(this.config?.outputsConfigured)
		return Number.isFinite(n) && n > 0 ? n : 16
	}
	effectiveInputs() {
		return this.inputsCount || this.configuredInputs()
	}
	effectiveOutputs() {
		return this.outputsCount || this.configuredOutputs()
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
			{ variableId: 'summary_alarm_ok', name: 'Summary alarm OK (O/F)' },
			{ variableId: 'selected_output', name: 'Selected destination number' },
			{ variableId: 'selected_output_name', name: 'Selected destination name' },
		]

		const outs = this.effectiveOutputs()
		const ins = this.effectiveInputs()

		for (let o = 1; o <= outs; o++) {
			defs.push({ variableId: `output_${pad3(o)}_name`, name: `Output ${pad3(o)} name` })
			defs.push({ variableId: `out_${pad3(o)}_src`, name: `Output ${pad3(o)} source (input number)` })
		}
		for (let i = 1; i <= ins; i++) {
			defs.push({ variableId: `input_${pad3(i)}_name`, name: `Input ${pad3(i)} name` })
		}

		this.setVariableDefinitions(defs)

		// Prefill placeholders so preset texts never appear blank when offline
		const vals = {}

		// Outputs
		for (let o = 1; o <= outs; o++) {
			vals[`output_${pad3(o)}_name`] = this.outputAliases[o - 1] || `O${pad3(o)}`
			// Keep src empty until we know it from status
			vals[`out_${pad3(o)}_src`] = this.currentSources[o - 1] != null ? String(this.currentSources[o - 1]) : ''
		}

		// Inputs
		for (let i = 1; i <= ins; i++) {
			vals[`input_${pad3(i)}_name`] = this.inputAliases[i - 1] || `I${pad3(i)}`
		}

		// Selected output friendly name
		if (this.selectedOutput) {
			vals['selected_output_name'] =
				this.outputAliases[this.selectedOutput - 1] || `Output ${pad3(this.selectedOutput)}`
		} else {
			vals['selected_output_name'] = ''
		}

		this.setVariableValues(vals)
	}

	// ---------- dropdown choices ----------
	getInputChoices() {
		if (this.inputAliases?.length) {
			return this.inputAliases.map((label, i) => ({
				id: String(i + 1),
				label: `${pad3(i + 1)}  ${label}`,
			}))
		}
		const n = Math.max(1, this.effectiveInputs())
		return Array.from({ length: n }, (_, i) => {
			const idx = i + 1
			return { id: String(idx), label: pad3(idx) }
		})
	}
	getOutputChoices() {
		if (this.outputAliases?.length) {
			return this.outputAliases.map((label, i) => ({
				id: String(i + 1),
				label: `${pad3(i + 1)}  ${label}`,
			}))
		}
		const n = Math.max(1, this.effectiveOutputs())
		return Array.from({ length: n }, (_, i) => {
			const idx = i + 1
			return { id: String(idx), label: pad3(idx) }
		})
	}
	getOddInputChoices() {
		const max = this.inputAliases?.length || this.effectiveInputs()
		const items = []
		for (let i = 1; i <= max; i += 2) {
			const l1 = this.inputAliases[i - 1] || ''
			const l2 = this.inputAliases[i] || ''
			const lbl = l2 ? `${pad3(i)}+${pad3(i + 1)}  ${l1} / ${l2}` : `${pad3(i)}  ${l1}`
			items.push({ id: String(i), label: lbl })
		}
		return items
	}
	getOddOutputChoices() {
		const max = this.outputAliases?.length || this.effectiveOutputs()
		const items = []
		for (let o = 1; o <= max; o += 2) {
			const l1 = this.outputAliases[o - 1] || ''
			const l2 = this.outputAliases[o] || ''
			const lbl = l2 ? `${pad3(o)}+${pad3(o + 1)}  ${l1} / ${l2}` : `${pad3(o)}  ${l1}`
			items.push({ id: String(o), label: lbl })
		}
		return items
	}

	// ---------- actions ----------
	initActions() {
		this.setActionDefinitions({
			test_connect: {
				name: 'Test Connect (send AB?)',
				options: [],
				callback: async () => {
					try {
						const body = `${this.dstAddr()}${this.srcAddr()}?`
						const msg = pkt(body) + '\r\n'
						const reply = await tcpRequest({
							host: this.host(),
							port: this.port(),
							message: msg,
							logger: (s) => this.log('debug', s),
						})
						this.log('debug', `RX: ${reply}`)
						this.setVariableValues({ last_reply: reply || '(no data)', last_error: '' })
						this.updateStatus(InstanceStatus.Ok)
					} catch (e) {
						this.updateStatus(InstanceStatus.ConnectionFailure, e?.message || 'connect failed')
						this.setVariableValues({ last_error: e?.message || String(e) })
						this.log('error', `Test Connect failed: ${e?.message || e}`)
					}
				},
			},

			read_full_status: {
				name: 'Read Full Status (?)',
				options: [],
				callback: async () => {
					await this.pollStatusOnce()
				},
			},

			read_quick_status: {
				name: 'Read Quick Status (Q)',
				options: [],
				callback: async () => {
					await this.pollQuickStatusOnce()
				},
			},

			// Route explicit
			route: {
				name: 'Route input to output (short switch s)',
				options: [
					{
						id: 'input',
						type: 'dropdown',
						label: 'Input',
						choices: this.getInputChoices(),
						allowCustom: true,
						default: '1',
					},
					{
						id: 'output',
						type: 'dropdown',
						label: 'Output',
						choices: this.getOutputChoices(),
						allowCustom: true,
						default: '1',
					},
				],
				callback: async ({ options }) => {
					const iNum = Number((await this.parseVariablesInString(String(options.input ?? ''))).trim())
					const oNum = Number((await this.parseVariablesInString(String(options.output ?? ''))).trim())
					const maxIn = this.inputAliases?.length || this.effectiveInputs()
					const maxOut = this.outputAliases?.length || this.effectiveOutputs()
					if (!Number.isFinite(iNum) || iNum < 1 || iNum > Math.max(999, maxIn))
						return this.log('error', `Input must be 1..${maxIn}`)
					if (!Number.isFinite(oNum) || oNum < 1 || oNum > Math.max(999, maxOut))
						return this.log('error', `Output must be 1..${maxOut}`)
					const body = `${this.dstAddr()}${this.srcAddr()}s,${pad3(oNum)},${pad3(iNum)}`
					await this.sendBody(body)
					// Recheck feedbacks after routing
					this.checkFeedbacks('srcMatchesSelected', 'pairMatchesSelected')
				},
			},

			// Route pairs explicit
			route_pair: {
				name: 'Route paired inputs to paired outputs',
				options: [
					{
						id: 'input_odd',
						type: 'dropdown',
						label: 'Odd input (routes i and i+1)',
						choices: this.getOddInputChoices(),
						allowCustom: true,
						default: '1',
					},
					{
						id: 'output_odd',
						type: 'dropdown',
						label: 'Odd output (routes o and o+1)',
						choices: this.getOddOutputChoices(),
						allowCustom: true,
						default: '1',
					},
				],
				callback: async ({ options }) => {
					const i1 = Number((await this.parseVariablesInString(String(options.input_odd ?? ''))).trim())
					const o1 = Number((await this.parseVariablesInString(String(options.output_odd ?? ''))).trim())
					const maxIn = this.inputAliases?.length || this.effectiveInputs()
					const maxOut = this.outputAliases?.length || this.effectiveOutputs()
					if (!Number.isFinite(i1) || i1 < 1 || i1 > maxIn || i1 % 2 === 0)
						return this.log('error', `Input must be odd 1..${maxIn}`)
					if (!Number.isFinite(o1) || o1 < 1 || o1 > maxOut || o1 % 2 === 0)
						return this.log('error', `Output must be odd 1..${maxOut}`)
					if (i1 + 1 > maxIn) return this.log('error', `Input pair overflows. Need ${i1 + 1}`)
					if (o1 + 1 > maxOut) return this.log('error', `Output pair overflows. Need ${o1 + 1}`)
					const DA = this.dstAddr(),
						SA = this.srcAddr()
					await this.sendBody(`${DA}${SA}s,${pad3(o1)},${pad3(i1)}`)
					await this.sendBody(`${DA}${SA}s,${pad3(o1 + 1)},${pad3(i1 + 1)}`)
					this.checkFeedbacks('srcMatchesSelected', 'pairMatchesSelected')
				},
			},

			// XY workflow helpers
			// Select Destination
			select_destination: {
				name: 'Select Destination',
				options: [
					{
						id: 'output',
						type: 'dropdown',
						label: 'Output',
						choices: this.getOutputChoices(),
						allowCustom: true,
						default: '1',
					},
				],
				callback: async ({ options }) => {
					const outs = this.effectiveOutputs()
					const o = Math.max(1, Math.min(outs, Number(options.output || 1)))
					this.selectedOutput = o
					this.setVariableValues({
						selected_output: String(o),
						selected_output_name: this.outputAliases[o - 1] || `Out ${pad3(o)}`,
					})
					// Force all feedbacks to re-evaluate on the panel
					this.checkFeedbacks()
				},
			},

			// Clear selection
			clear_selection: {
				name: 'Clear Selected Destination',
				options: [],
				callback: async () => {
					this.selectedOutput = null
					this.setVariableValues({ selected_output: '', selected_output_name: '' })
					this.checkFeedbacks()
				},
			},

			// Route single
			route_to_selected: {
				name: 'Route Input to Selected Destination',
				options: [
					{
						id: 'input',
						type: 'dropdown',
						label: 'Input',
						choices: this.getInputChoices(),
						allowCustom: true,
						default: '1',
					},
				],
				callback: async ({ options }) => {
					const i = Number(options.input || 1)
					if (!this.selectedOutput) return this.log('error', 'Select a destination first')
					const maxIn = this.inputAliases?.length || this.effectiveInputs()
					if (i < 1 || i > Math.max(999, maxIn)) return this.log('error', `Input must be 1..${maxIn}`)
					const body = `${this.dstAddr()}${this.srcAddr()}s,${pad3(this.selectedOutput)},${pad3(i)}`
					await this.sendBody(body)
					this.checkFeedbacks()
				},
			},

			// Route pair
			route_pair_to_selected: {
				name: 'Route Paired Inputs to Selected Dest Pair',
				options: [
					{
						id: 'input_odd',
						type: 'dropdown',
						label: 'Odd input (i and i+1)',
						choices: this.getOddInputChoices(),
						allowCustom: true,
						default: '1',
					},
				],
				callback: async ({ options }) => {
					const i1 = Number(options.input_odd || 1)
					if (!this.selectedOutput) return this.log('error', 'Select a destination first')
					const o1 = this.selectedOutput
					const maxIn = this.inputAliases?.length || this.effectiveInputs()
					const maxOut = this.outputAliases?.length || this.effectiveOutputs()
					if (i1 < 1 || i1 % 2 === 0 || i1 + 1 > maxIn) return this.log('error', 'Input must be odd and in range')
					if (o1 % 2 === 0 || o1 + 1 > maxOut)
						return this.log('error', 'Selected destination must be odd and o+1 must exist')
					const DA = this.dstAddr(),
						SA = this.srcAddr()
					await this.sendBody(`${DA}${SA}s,${pad3(o1)},${pad3(i1)}`)
					await this.sendBody(`${DA}${SA}s,${pad3(o1 + 1)},${pad3(i1 + 1)}`)
					this.checkFeedbacks()
				},
			},
		})
	}

	// ---------- feedbacks ----------
	initFeedbacks() {
		this.setFeedbackDefinitions({
			// Yellow background when destination button matches selected
			destSelected: {
				name: 'Destination is selected',
				type: 'boolean',
				options: [{ type: 'number', id: 'output', label: 'Output', default: 1, min: 1, max: 999 }],
				defaultStyle: { bgcolor: 0xffff00, color: 0x000000 },
				callback: (fb) => {
					const out = safeInt(fb.options.output, 0)
					return this.selectedOutput === out
				},
			},

			// Green when routed to selected destination
			srcMatchesSelected: {
				name: 'Source is routed to selected destination',
				type: 'boolean',
				options: [{ type: 'number', id: 'input', label: 'Input', default: 1, min: 1, max: 999 }],
				defaultStyle: { bgcolor: 0x00ff00, color: 0x000000 },
				callback: (fb) => {
					const i = Number(fb.options.input ?? -1)
					const o = this.selectedOutput
					if (!o) return false
					const cur = Number(this.currentSources[o - 1] ?? -2)
					return cur === i
				},
			},

			// Green when both members match for the selected odd destination pair
			pairMatchesSelected: {
				name: 'Paired inputs match selected odd destination pair',
				type: 'boolean',
				options: [{ type: 'number', id: 'input_odd', label: 'Odd input', default: 1, min: 1, max: 999 }],
				defaultStyle: { bgcolor: 0x00ff00, color: 0x000000 },
				callback: (fb) => {
					const i1 = Number(fb.options.input_odd ?? 0)
					const o1 = this.selectedOutput
					if (!o1 || i1 % 2 === 0 || o1 % 2 === 0) return false
					const i2 = i1 + 1
					const o2 = o1 + 1
					const cur1 = Number(this.currentSources[o1 - 1] ?? -99)
					const cur2 = Number(this.currentSources[o2 - 1] ?? -98)
					return cur1 === i1 && cur2 === i2
				},
			},
		})
	}

	// ---------- presets ----------
	buildAndSetPresets() {
		const presets = []
		const outs = this.effectiveOutputs()
		const ins = this.effectiveInputs()

		// Use this instance's label so Companion variable tokens resolve
		const inst = this.label || this.instanceLabel || 'etl-matrix'

		// Category: XY Destinations
		for (let o = 1; o <= outs; o++) {
			presets.push({
				type: 'button',
				category: 'XY: Destinations',
				name: `Dest ${pad3(o)}`,
				style: {
					// Show live output name from variables
					text: `${pad3(o)}\n$(${inst}:output_${pad3(o)}_name)`,
					size: '14',
					color: 0xffffff,
					bgcolor: 0x333333,
				},
				steps: [{ down: [{ actionId: 'select_destination', options: { output: String(o) } }] }],
				feedbacks: [
					{ feedbackId: 'destSelected', options: { output: o }, style: { bgcolor: 0xffff00, color: 0x000000 } },
				],
			})
		}

		// Category: XY Sources (Loose) no 000
		for (let i = 1; i <= ins; i++) {
			presets.push({
				type: 'button',
				category: 'XY: Sources (Loose)',
				name: `Src ${pad3(i)}`,
				style: {
					// Show live input name from variables
					text: `${pad3(i)}\n$(${inst}:input_${pad3(i)}_name)`,
					size: '14',
					color: 0xffffff,
					bgcolor: 0x000000,
				},
				steps: [{ down: [{ actionId: 'route_to_selected', options: { input: String(i) } }] }],
				feedbacks: [
					{ feedbackId: 'srcMatchesSelected', options: { input: i }, style: { bgcolor: 0x00ff00, color: 0x000000 } },
				],
			})
		}

		// Category: XY Sources (Paired) using odd inputs
		for (let i = 1; i <= ins; i += 2) {
			const hasNext = i + 1 <= ins
			const pairText = hasNext
				? `${pad3(i)}+${pad3(i + 1)}\n$(${inst}:input_${pad3(i)}_name) / $(${inst}:input_${pad3(i + 1)}_name)`
				: `${pad3(i)}\n$(${inst}:input_${pad3(i)}_name)`
			presets.push({
				type: 'button',
				category: 'XY: Sources (Paired)',
				name: `Pair ${pad3(i)}`,
				style: {
					text: pairText,
					size: '12',
					color: 0xffffff,
					bgcolor: 0x111111,
				},
				steps: [{ down: [{ actionId: 'route_pair_to_selected', options: { input_odd: String(i) } }] }],
				feedbacks: [
					{
						feedbackId: 'pairMatchesSelected',
						options: { input_odd: i },
						style: { bgcolor: 0x00ff00, color: 0x000000 },
					},
				],
			})
		}

		this.setPresetDefinitions(presets)
	}

	// ---------- alias polling ----------
	startAliasPolling() {
		this.stopAliasPolling()
		const interval = Math.max(500, Number(this.config.aliasPollMs || 5000))
		this.aliasTimer = setInterval(() => {
			this.pollAliasesOnce().catch((e) => this.log('debug', `Alias poll error: ${e?.message || e}`))
		}, interval)
	}
	stopAliasPolling() {
		if (this.aliasTimer) {
			clearInterval(this.aliasTimer)
			this.aliasTimer = null
		}
	}
	parseAliasDump(reply) {
		// Example: {BAT?,C1-1,...,C4-4,ANT1,...,AN16}g
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
		try {
			const body = `${this.dstAddr()}${this.srcAddr()}T?`
			const msg = pkt(body) + '\r\n'
			const reply = await tcpRequest({
				host: this.host(),
				port: this.port(),
				message: msg,
				logger: (s) => this.log('debug', s),
			})
			if (!reply) return this._markWarn('Alias poll: empty reply')

			this.setVariableValues({ last_alias_dump: reply, last_error: '' })
			this.log('debug', `Alias dump RX: ${reply}`)

			const parsed = this.parseAliasDump(reply)
			if (!parsed) return this._markWarn('Alias poll: parse failed')

			const { outAliases, inAliases } = parsed
			this.outputAliases = outAliases
			this.inputAliases = inAliases

			const changed = outAliases.length !== this.outputsCount || inAliases.length !== this.inputsCount
			this.outputsCount = outAliases.length
			this.inputsCount = inAliases.length
			if (changed) {
				this.rebuildVariableDefinitions()
				this.buildAndSetPresets()
			}

			const vals = {}
			outAliases.forEach((name, idx) => (vals[`output_${pad3(idx + 1)}_name`] = name))
			inAliases.forEach((name, idx) => (vals[`input_${pad3(idx + 1)}_name`] = name))
			this.setVariableValues(vals)

			// refresh dropdowns and feedback lighting
			this.initActions()
			this.checkFeedbacks('srcMatchesSelected', 'pairMatchesSelected')

			this._markOk('Alias poll ok')
		} catch (e) {
			this._markFail(e)
		}
	}

	// ---------- status polling ----------
	startStatusPolling() {
		this.stopStatusPolling()
		const interval = Math.max(200, Number(this.config.statusPollMs || 750))
		this.statusTimer = setInterval(() => {
			this.pollStatusOnce().catch((e) => this.log('debug', `Status poll error: ${e?.message || e}`))
		}, interval)
	}
	stopStatusPolling() {
		if (this.statusTimer) {
			clearInterval(this.statusTimer)
			this.statusTimer = null
		}
	}
	parseFullStatus(reply) {
		// Example: {BASTATUS,001,002,003,...,016,O,F,O,F}<csum>
		const start = reply.indexOf('{')
		const end = reply.lastIndexOf('}')
		if (start < 0 || end < 0 || end <= start) return null
		const inner = reply.slice(start + 1, end)
		const parts = inner.split(',')
		if (parts.length < 2) return null
		const header = parts[0]
		if (!header.includes('STATUS')) return null
		if (parts.length < 6) return null
		const flags = parts.slice(-4)
		const nums = parts.slice(1, -4)
		const sources = nums.map((n) => {
			const v = parseInt(n, 10)
			return isNaN(v) ? 0 : v
		})
		return { sources, flags }
	}
	async pollStatusOnce() {
		try {
			const body = `${this.dstAddr()}${this.srcAddr()}?`
			const msg = pkt(body) + '\r\n'
			const reply = await tcpRequest({
				host: this.host(),
				port: this.port(),
				message: msg,
				logger: (s) => this.log('debug', s),
			})
			if (!reply) return this._markWarn('Status poll: empty reply')

			this.setVariableValues({ last_status_raw: reply, last_error: '' })
			this.log('debug', `Status RX: ${reply}`)

			const parsed = this.parseFullStatus(reply)
			if (!parsed) return this._markWarn('Status poll: parse failed')

			const { sources, flags } = parsed

			// track internally for feedbacks
			this.currentSources = sources.slice()

			if (!this.outputsCount || this.outputsCount !== sources.length) {
				this.outputsCount = sources.length
				this.rebuildVariableDefinitions()
				this.buildAndSetPresets()
			}

			const vals = {}
			sources.forEach((srcNum, idx) => {
				vals[`out_${pad3(idx + 1)}_src`] = String(srcNum)
			})
			const [psu1, psu2, link, summary] = flags
			vals['psu1_ok'] = psu1 || ''
			vals['psu2_ok'] = psu2 || ''
			vals['link_ok'] = link || ''
			vals['summary_alarm_ok'] = summary || ''
			this.setVariableValues(vals)

			// refresh lighting for XY
			this.checkFeedbacks()

			this._markOk('Full status poll ok')
		} catch (e) {
			this._markFail(e)
		}
	}
	async pollQuickStatusOnce() {
		try {
			const body = `${this.dstAddr()}${this.srcAddr()}Q`
			const msg = pkt(body) + '\r\n'
			const reply = await tcpRequest({
				host: this.host(),
				port: this.port(),
				message: msg,
				logger: (s) => this.log('debug', s),
			})
			if (!reply) return this._markWarn('Quick status: empty reply')
			// Example quick: {BAQOFOF}<csum>
			const start = reply.indexOf('{')
			const end = reply.lastIndexOf('}')
			if (start >= 0 && end > start) {
				const inner = reply.slice(start + 1, end)
				if (inner.length >= 6 && inner[2] === 'Q') {
					const flags = inner.slice(3)
					this.setVariableValues({
						psu1_ok: flags[0] || '',
						psu2_ok: flags[1] || '',
						link_ok: flags[2] || '',
						summary_alarm_ok: flags[3] || '',
					})
					this._markOk('Quick status poll ok')
					return
				}
			}
			this._markWarn('Quick status: parse failed')
		} catch (e) {
			this._markFail(e)
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
				logger: (s) => this.log('debug', s),
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
			{
				type: 'static-text',
				id: 'info',
				label: 'Info',
				value: 'Host and port. Port default is 4000. DA and SA usually A and B.',
			},
			{ type: 'textinput', id: 'host', label: 'Host', width: 6, default: '192.168.0.252', regex: Regex.IP },
			{ type: 'number', id: 'port', label: 'Port', width: 6, default: 4000, min: 1, max: 65535 },
			{ type: 'textinput', id: 'dstAddr', label: 'Destination address char', width: 3, default: 'A' },
			{ type: 'textinput', id: 'srcAddr', label: 'Source address char', width: 3, default: 'B' },

			// matrix sizing
			{ type: 'number', id: 'inputsConfigured', label: 'Inputs count', width: 6, default: 16, min: 1, max: 999 },
			{ type: 'number', id: 'outputsConfigured', label: 'Outputs count', width: 6, default: 16, min: 1, max: 999 },

			{
				type: 'number',
				id: 'aliasPollMs',
				label: 'Alias poll interval ms',
				width: 6,
				default: 5000,
				min: 200,
				max: 60000,
			},
			{
				type: 'number',
				id: 'statusPollMs',
				label: 'Status poll interval ms',
				width: 6,
				default: 750,
				min: 100,
				max: 5000,
			},
		]
	}

	async configUpdated(config) {
		this.config = config
		this.updateStatus(InstanceStatus.Unknown)

		// Rebuild UI immediately to reflect new sizing
		this.rebuildVariableDefinitions()
		this.initActions()
		this.initFeedbacks()
		this.buildAndSetPresets()

		this.startAliasPolling()
		this.startStatusPolling()

		// immediate polls on settings save
		try {
			await this.pollAliasesOnce()
		} catch (e) {
			this.log('debug', `Alias poll after config update error: ${e?.message || e}`)
		}
		try {
			await this.pollStatusOnce()
		} catch (e) {
			this.log('debug', `Status poll after config update error: ${e?.message || e}`)
		}
	}

	async destroy() {
		this.stopAliasPolling()
		this.stopStatusPolling()
	}
}

runEntrypoint(EtlRfMatrixInstance)
