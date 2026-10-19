/**
 * QQ ⇄ DeepSeek Harness bridge — Client half.
 *
 * A quiet strip below the composer shows which QQ contact THIS conversation is
 * wired to, and opens into the panel that sets it up: the QQ connection, the
 * contact, the group-only "@ me" rule, and the advanced trust switch.
 *
 * WHY THE HOST IS REACHED OVER HTTP
 *
 * A profile plugin has no host-call bridge, so everything below is a fetch
 * against `/dsh-qq-bridge/*`, which the Host half registers on the Harness web
 * server. Every call is same-origin, and the Host checks that.
 *
 * WHY THE SWITCHES LOOK LIKE HOST SWITCHES
 *
 * The panel is part of the Harness UI, so it uses `--dsw-alias-*` tokens only
 * and carries the accessibility contract a real switch needs (`role="switch"`,
 * `aria-checked`, keyboard operation) rather than importing a Harness client
 * package.
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-qq-bridge",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const API = "/dsh-qq-bridge";

    const token = {
      text: "var(--dsw-alias-label-primary)",
      dim: "var(--dsw-alias-label-secondary)",
      border: "var(--dsw-alias-border-l1)",
      borderStrong: "var(--dsw-alias-border-l2)",
      surface: "var(--dsw-alias-bg-layer-1)",
      surface2: "var(--dsw-alias-bg-layer-2)",
      overlay: "var(--dsw-alias-bg-overlay)",
      brand: "var(--dsw-alias-brand-primary)",
      ok: "var(--dsw-alias-state-success-primary)",
      idle: "var(--dsw-alias-state-idle-primary)",
      warn: "var(--dsw-alias-state-warn-primary)",
      error: "var(--dsw-alias-state-error-primary)",
    };

    async function api(path, options) {
      const response = await fetch(`${API}${path}`, options);
      const payload = await response.json().catch(() => null);
      if (payload === null || payload.ok !== true) {
        throw new Error((payload && payload.error) || `HTTP ${response.status}`);
      }
      return payload;
    }

    function post(path, body) {
      return api(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    /* ------------------------------------------------------------- controls */

    function Switch(props) {
      const { checked, onChange, label, hint, disabled } = props;
      const on = checked === true;
      const toggle = () => {
        if (disabled !== true) onChange(!on);
      };
      return h(
        "div",
        { style: { display: "flex", alignItems: "flex-start", gap: 10, padding: "6px 0" } },
        h(
          "button",
          {
            type: "button",
            role: "switch",
            "aria-checked": on,
            "aria-label": label,
            disabled: disabled === true,
            onClick: toggle,
            onKeyDown: (event) => {
              if (event.key === " " || event.key === "Enter") {
                event.preventDefault();
                toggle();
              }
            },
            style: {
              flex: "0 0 auto",
              marginTop: 2,
              width: 34,
              height: 18,
              padding: 0,
              borderRadius: 999,
              border: `1px solid ${on ? "transparent" : token.borderStrong}`,
              background: on ? token.brand : token.surface2,
              cursor: disabled === true ? "not-allowed" : "pointer",
              opacity: disabled === true ? 0.55 : 1,
              position: "relative",
              transition: "background 120ms ease",
            },
          },
          h("span", {
            style: {
              position: "absolute",
              top: 2,
              left: on ? 18 : 2,
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: "#ffffff",
              boxShadow: "0 1px 2px rgba(0,0,0,0.28)",
              transition: "left 120ms ease",
            },
          }),
        ),
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 } },
          h("span", { style: { fontSize: 12.5, color: token.text } }, label),
          hint ? h("span", { style: { fontSize: 11.5, lineHeight: 1.5, color: token.dim } }, hint) : null,
        ),
      );
    }

    function Button(props) {
      const { children, onClick, disabled, primary, title } = props;
      return h(
        "button",
        {
          type: "button",
          onClick,
          disabled: disabled === true,
          title,
          style: {
            appearance: "none",
            border: `1px solid ${primary ? "transparent" : token.border}`,
            background: primary ? token.brand : token.surface2,
            color: primary ? "#ffffff" : token.text,
            borderRadius: 6,
            padding: "4px 10px",
            fontSize: 12,
            lineHeight: "18px",
            cursor: disabled === true ? "not-allowed" : "pointer",
            opacity: disabled === true ? 0.55 : 1,
            whiteSpace: "nowrap",
          },
        },
        children,
      );
    }

    function TextField(props) {
      const { value, onChange, placeholder, width, type } = props;
      return h("input", {
        type: type || "text",
        value: value,
        placeholder,
        spellCheck: false,
        onChange: (event) => onChange(event.target.value),
        style: {
          width: width || "100%",
          boxSizing: "border-box",
          border: `1px solid ${token.border}`,
          background: token.surface2,
          color: token.text,
          borderRadius: 6,
          padding: "4px 8px",
          fontSize: 12,
          lineHeight: "18px",
          outline: "none",
          fontFamily: "inherit",
        },
      });
    }

    function Field(props) {
      return h(
        "label",
        { style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 } },
        h("span", { style: { fontSize: 11.5, color: token.dim } }, props.label),
        props.children,
      );
    }

    function Section(props) {
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 8, minWidth: 0 } },
        h(
          "div",
          {
            style: {
              fontSize: 11,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: token.dim,
              paddingTop: 4,
            },
          },
          props.title,
        ),
        props.children,
      );
    }

    function statusColor(state) {
      if (state.connection && state.connection.connected) return token.ok;
      if (state.connection && state.connection.lastError) return token.error;
      return token.idle;
    }

    function describe(binding) {
      if (!binding) return "未关联";
      const kind = binding.peerKind === "group" ? "群" : "私聊";
      const name = binding.peerName ? `「${binding.peerName}」` : "";
      const quiet = binding.peerKind === "group" && binding.mentionOnly ? " · 仅@回复" : "";
      const trust = binding.authoritative ? " · 权威输入" : "";
      return `${kind} ${name}${binding.peerId}${quiet}${trust}`;
    }

    /* --------------------------------------------------------------- panel */

    function QqBridgeDock(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : "";
      const [open, setOpen] = useState(false);
      const [state, setState] = useState(null);
      const [error, setError] = useState("");
      const [busy, setBusy] = useState(false);

      const [wsUrl, setWsUrl] = useState("");
      const [accessToken, setAccessToken] = useState("");
      const [httpApiUrl, setHttpApiUrl] = useState("");
      const [httpToken, setHttpToken] = useState("");
      const [selfIdInput, setSelfIdInput] = useState("");
      const [peerKind, setPeerKind] = useState("private");
      const [peerId, setPeerId] = useState("");
      const [peerName, setPeerName] = useState("");
      const [peers, setPeers] = useState(null);
      const [toast, setToast] = useState("");
      const mounted = useRef(true);
      // While the panel is open it polls for status. Without this guard every
      // poll re-hydrated the inputs from the saved config and wiped out whatever
      // was being typed — which is why the WebSocket address could not be
      // changed. A group counts as dirty from the first edit until the next
      // successful save.
      const editingConnection = useRef(false);
      const editingBinding = useRef(false);

      /** Mark a form group dirty, then apply the edit. */
      const edit = useCallback(
        (dirty, setter) => (value) => {
          dirty.current = true;
          setter(value);
        },
        [],
      );

      useEffect(() => {
        mounted.current = true;
        return () => {
          mounted.current = false;
        };
      }, []);

      const applyState = useCallback((next) => {
        if (!mounted.current) return;
        setState(next);
        if (next.connection) {
          if (!editingConnection.current) {
            setWsUrl(next.connection.wsUrl || "");
            setHttpApiUrl(next.connection.httpApiUrl || "");
            setSelfIdInput(next.connection.selfId || "");
            // Secrets are write-only: they are never hydrated back into the
            // fields, and must not be cleared while one is being typed either.
            setAccessToken("");
            setHttpToken("");
          }
        }
        if (next.binding && !editingBinding.current) {
          setPeerKind(next.binding.peerKind);
          setPeerId(next.binding.peerId);
          setPeerName(next.binding.peerName || "");
        }
      }, []);

      const refresh = useCallback(async () => {
        if (sessionId === "") return;
        try {
          const next = await api(`/state?sessionId=${encodeURIComponent(sessionId)}`);
          applyState(next);
          setError("");
        } catch (failure) {
          if (mounted.current) setError(String(failure.message || failure));
        }
      }, [sessionId, applyState]);

      useEffect(() => {
        void refresh();
      }, [refresh]);

      // The strip is the only place the binding is visible, and it can be
      // changed from another window or from outside this page, so it refreshes
      // on mount, every 15s while collapsed, and every 5s while open.
      useEffect(() => {
        void refresh();
        const timer = setInterval(
          () => {
            void refresh();
          },
          open ? 5000 : 15000,
        );
        return () => clearInterval(timer);
      }, [open, refresh]);

      const run = useCallback(
        async (operation, done) => {
          setBusy(true);
          setError("");
          try {
            await operation();
            // Saved: the server is now the source of truth again.
            editingConnection.current = false;
            editingBinding.current = false;
            await refresh();
            if (done && mounted.current) {
              setToast(done);
              setTimeout(() => {
                if (mounted.current) setToast("");
              }, 2500);
            }
          } catch (failure) {
            if (mounted.current) setError(String(failure.message || failure));
          } finally {
            if (mounted.current) setBusy(false);
          }
        },
        [refresh],
      );

      if (sessionId === "") return null;

      const binding = state ? state.binding : null;
      const connection = (state && state.connection) || { connected: false };
      const isGroup = binding ? binding.peerKind === "group" : peerKind === "group";
      const summary = state === null ? "读取中…" : describe(binding);

      const statusDot = h("span", {
        style: {
          width: 6,
          height: 6,
          borderRadius: "50%",
          flex: "0 0 auto",
          background: statusColor(state || { connection: { connected: false } }),
        },
      });

      const summaryText = h(
        "span",
        {
          style: {
            color: binding ? token.text : token.dim,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          },
        },
        summary,
      );

      /**
       * Collapsed: a compact chip that sits inline with the host's own ambient
       * entries. It has to stay transparent and fit-content — a full-width
       * block with a surface fill reads as a stray panel sitting in that row.
       */
      if (!open) {
        return h(
          "button",
          {
            type: "button",
            title: "展开 QQ 桥接设置",
            onClick: () => setOpen(true),
            style: {
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              maxWidth: 210,
              minWidth: 0,
              margin: 0,
              padding: "2px 6px",
              border: "none",
              borderRadius: 6,
              background: "transparent",
              color: token.dim,
              fontSize: 11.5,
              lineHeight: "18px",
              cursor: "pointer",
              fontFamily: "inherit",
            },
          },
          statusDot,
          h("span", { style: { flex: "0 0 auto" } }, "QQ"),
          summaryText,
        );
      }

      /** Expanded: the same row, now serving as the popover's anchor. */
      const panelHeader = h(
        "button",
        {
          type: "button",
          "aria-expanded": true,
          onClick: () => setOpen(false),
          title: "收起 QQ 桥接设置",
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            maxWidth: 210,
            minWidth: 0,
            margin: 0,
            padding: "2px 6px",
            border: "none",
            borderRadius: 6,
            background: "transparent",
            color: token.dim,
            fontSize: 11.5,
            lineHeight: "18px",
            cursor: "pointer",
            fontFamily: "inherit",
          },
        },
        statusDot,
        h("span", { style: { flex: "0 0 auto" } }, "QQ"),
        summaryText,
        h("span", { style: { flex: "0 0 auto", opacity: 0.7 } }, "· 收起"),
      );

      const friends = (peers && peers.friends) || [];
      const groups = (peers && peers.groups) || [];
      const options = isGroup ? groups : friends;

      return h(
        "div",
        {
          style: {
            position: "relative",
            display: "inline-flex",
            alignItems: "center",
            minWidth: 0,
          },
        },
        panelHeader,
        // A popover anchored above the row. It overlays the conversation the
        // way the host's own stats card does, so opening it never pushes the
        // composer up or reflows the transcript.
        h(
          "div",
          {
            style: {
              position: "absolute",
              bottom: "100%",
              right: 0,
              marginBottom: 8,
              zIndex: 40,
              width: 420,
              maxWidth: "min(90vw, 420px)",
              maxHeight: "min(58vh, 440px)",
              overflowY: "auto",
              overscrollBehavior: "contain",
              boxSizing: "border-box",
              background: token.overlay,
              // The theme's surfaces are translucent; a popover must be
              // readable over the transcript, so blur what shows through.
              backdropFilter: "blur(16px) saturate(140%)",
              WebkitBackdropFilter: "blur(16px) saturate(140%)",
              border: `1px solid ${token.border}`,
              borderRadius: 12,
              boxShadow: "0 10px 30px rgba(0, 0, 0, 0.22)",
              padding: "10px 12px",
              display: "flex",
              flexDirection: "column",
              gap: 10,
              fontSize: 12,
              color: token.text,
            },
          },

        error ? h("div", { style: { color: token.error, fontSize: 11.5, lineHeight: 1.5 } }, error) : null,
        toast ? h("div", { style: { color: token.ok, fontSize: 11.5 } }, toast) : null,

        h(
          Section,
          { title: "QQ 连接" },
          h(
            "div",
            { style: { display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" } },
            h(
              "div",
              { style: { flex: "1 1 240px", minWidth: 0 } },
              h(Field, { label: "OneBot 正向 WebSocket 地址" }, h(TextField, {
                value: wsUrl,
                onChange: edit(editingConnection, setWsUrl),
                placeholder: "ws://127.0.0.1:3001",
              })),
            ),
            h(
              "div",
              { style: { flex: "1 1 160px", minWidth: 0 } },
              h(Field, { label: "Access token（OneBot 的，不是 WebUI 那个）" }, h(TextField, {
                value: accessToken,
                onChange: edit(editingConnection, setAccessToken),
                type: "password",
                placeholder: connection.hasAccessToken ? "已保存，留空则不修改" : "留空表示不鉴权",
              })),
            ),          ),
          h(
            "div",
            { style: { display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" } },
            h(
              "div",
              { style: { flex: "1 1 200px", minWidth: 0 } },
              h(Field, { label: "HTTP API 地址（可选，WS 断开时兜底）" }, h(TextField, {
                value: httpApiUrl,
                onChange: edit(editingConnection, setHttpApiUrl),
                placeholder: "http://127.0.0.1:3000",
              })),
            ),
            h(
              "div",
              { style: { flex: "0 1 160px", minWidth: 0 } },
              h(Field, { label: "HTTP token（仅在与上面不同时填）" }, h(TextField, {
                value: httpToken,
                onChange: edit(editingConnection, setHttpToken),
                type: "password",
                placeholder: connection.hasHttpToken ? "已保存，留空则不修改" : "留空表示沿用上面的 token",
              })),
            ),
            h(
              "div",
              { style: { flex: "0 1 140px", minWidth: 0 } },
              h(Field, { label: "机器人 QQ 号（可选）" }, h(TextField, {
                value: selfIdInput,
                onChange: edit(editingConnection, setSelfIdInput),
                placeholder: "自动获取",
              })),
            ),
            h(Button, {
              primary: true,
              disabled: busy,
              onClick: () =>
                run(
                  () =>
                    post("/connection", {
                      wsUrl,
                      httpApiUrl,
                      selfId: selfIdInput,
                      // Both secrets are write-only: an empty field means
                      // "leave what is stored alone", not "erase it".
                      ...(accessToken === "" ? {} : { accessToken }),
                      ...(httpToken === "" ? {} : { httpToken }),
                    }),
                  "连接设置已保存",
                ),
            }, "保存并连接"),
            h(Button, {
              disabled: busy,
              onClick: () =>
                run(async () => {
                  const result = await post("/test", {});
                  if (result.ok !== true) throw new Error(result.error || "连接失败");
                }, "连接正常"),
            }, "测试连接"),
          ),
          h(
            "div",
            { style: { fontSize: 11.5, color: connection.connected ? token.ok : token.dim, lineHeight: 1.5 } },
            connection.connected
              ? `已连接${connection.selfId ? ` · 机器人 ${connection.selfId}` : ""}`
              : connection.lastError
                ? `未连接：${connection.lastError}`
                : "未连接（保存设置后会尝试连接）",
          ),
        ),

        h(
          Section,
          { title: "本会话关联的联系人" },
          h(
            "div",
            { style: { display: "flex", gap: 12, alignItems: "center" } },
            h(
              "label",
              { style: { display: "flex", gap: 5, alignItems: "center", cursor: "pointer" } },
              h("input", {
                type: "radio",
                checked: peerKind === "private",
                onChange: () => {
                  editingBinding.current = true;
                  setPeerKind("private");
                },
              }),
              "私聊",
            ),
            h(
              "label",
              { style: { display: "flex", gap: 5, alignItems: "center", cursor: "pointer" } },
              h("input", {
                type: "radio",
                checked: peerKind === "group",
                onChange: () => {
                  editingBinding.current = true;
                  setPeerKind("group");
                },
              }),
              "群聊",
            ),
            h(
              "div",
              { style: { marginLeft: "auto" } },
              h(Button, {
                disabled: busy,
                onClick: () =>
                  run(async () => {
                    const result = await api("/peers");
                    setPeers(result);
                    if (result.available !== true) {
                      throw new Error(result.error || "还没连上 QQ，无法拉取列表，请直接手填号码");
                    }
                  }),
              }, "从 QQ 拉取列表"),
            ),
          ),
          h(
            "div",
            { style: { display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" } },
            h(
              "div",
              { style: { flex: "0 1 160px", minWidth: 0 } },
              h(Field, { label: peerKind === "group" ? "群号" : "QQ 号" }, h(TextField, {
                value: peerId,
                onChange: edit(editingBinding, setPeerId),
                placeholder: "例如 10001",
              })),
            ),
            h(
              "div",
              { style: { flex: "1 1 160px", minWidth: 0 } },
              h(Field, { label: "备注名（可选）" }, h(TextField, {
                value: peerName,
                onChange: edit(editingBinding, setPeerName),
                placeholder: "只用于界面显示",
              })),
            ),
            options.length > 0
              ? h(
                  "div",
                  { style: { flex: "1 1 200px", minWidth: 0 } },
                  h(
                    Field,
                    { label: "或从列表选择" },
                    h(
                      "select",
                      {
                        value: "",
                        onChange: (event) => {
                          const value = event.target.value;
                          if (value === "") return;
                          const found = options.find((item) => item.id === value);
                          editingBinding.current = true;
                          setPeerId(value);
                          setPeerName(found ? found.name : "");
                        },
                        style: {
                          width: "100%",
                          border: `1px solid ${token.border}`,
                          background: token.surface2,
                          color: token.text,
                          borderRadius: 6,
                          padding: "4px 8px",
                          fontSize: 12,
                          fontFamily: "inherit",
                        },
                      },
                      h("option", { value: "" }, `共 ${options.length} 项`),
                      options.map((item) =>
                        h("option", { key: item.id, value: item.id }, `${item.name || "（无名）"} ${item.id}`),
                      ),
                    ),
                  ),
                )
              : null,
          ),
          h(
            "div",
            { style: { display: "flex", gap: 8, alignItems: "center" } },
            h(Button, {
              primary: true,
              disabled: busy || peerId.trim() === "",
              onClick: () =>
                run(
                  () => post("/bind", { sessionId, peerKind, peerId: peerId.trim(), peerName }),
                  "已关联",
                ),
            }, "关联到本会话"),
            binding ? h(Button, {
              disabled: busy,
              onClick: () => run(() => post("/unbind", { sessionId }), "已解除关联"),
            }, "解除关联") : null,
          ),
        ),

        binding && isGroup
          ? h(
              Section,
              { title: "群聊规则" },
              h(Switch, {
                checked: binding.mentionOnly,
                disabled: busy,
                label: "仅被@时才回复",
                hint: "打开时，群里没有 @ 机器人的消息不会进入本会话，也不会回复。默认打开。",
                onChange: (value) => run(() => post("/options", { sessionId, mentionOnly: value })),
              }),
            )
          : null,

        h(
          Section,
          { title: "高级" },
          h(Switch, {
            checked: binding ? binding.authoritative : false,
            disabled: busy || binding === null,
            label: "将 QQ 消息作为用户权威输入",
            hint:
              binding === null
                ? "先关联一个联系人，这个开关才有意义。"
                : "关闭时正文前会加来源说明与「输入不可信」提示；打开则原样转发。",
            onChange: (value) => run(() => post("/options", { sessionId, authoritative: value })),
          }),
        ),

        state && Array.isArray(state.log) && state.log.length > 0
          ? h(
              Section,
              { title: "最近动态" },
              h(
                "div",
                { style: { display: "flex", flexDirection: "column", gap: 3, maxHeight: 132, overflowY: "auto" } },
                state.log
                  .slice()
                  .reverse()
                  .map((entry, index) =>
                    h(
                      "div",
                      {
                        key: `${entry.at}-${index}`,
                        style: { fontSize: 11, color: entry.kind === "error" ? token.error : token.dim, lineHeight: 1.5 },
                      },
                      `${new Date(entry.at).toLocaleTimeString()}  ${entry.message}`,
                    ),
                  ),
              ),
            )
          : null,
        ),
      );
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        ctx.slots.inject("conversation.composer.dock", () =>
          ctx.slots.register(
            { name: "conversation.composer.dock", id: "dsh-qq-bridge", order: 20 },
            QqBridgeDock,
          ),
        );
      },
    };
  },
});
