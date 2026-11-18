package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"

	"chuangyi/provider-engine/internal/protocol"
)

func withProgress(c command, result any, raw []byte) any {
	var manifest map[string]any
	if json.Unmarshal(c.Definition.Manifest, &manifest) != nil {
		return result
	}
	contributes, _ := manifest["contributes"].(map[string]any)
	providers, _ := contributes["providers"].([]any)
	for _, entry := range providers {
		provider, _ := entry.(map[string]any)
		if provider == nil {
			continue
		}
		id, _ := provider["id"].(string)
		if id != c.Definition.ProviderID && !(c.Definition.ProviderID == "" && len(providers) == 1) {
			continue
		}
		response, _ := provider["response"].(map[string]any)
		expression, exists := response["progress"]
		if !exists {
			return result
		}
		value, err := protocol.EvaluateResponseExpression(expression, c.Request, c.TaskID, raw)
		if err != nil {
			return result
		}
		number, ok := value.(float64)
		if !ok {
			if text, yes := value.(string); yes {
				number, err = strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(text), "%"), 64)
				ok = err == nil
			}
		}
		if !ok || math.IsNaN(number) || math.IsInf(number, 0) || number < 0 || number > 100 {
			return result
		}
		encoded, err := json.Marshal(result)
		if err != nil {
			return result
		}
		var output map[string]any
		if json.Unmarshal(encoded, &output) != nil {
			return result
		}
		output["progress"] = number
		return output
	}
	return result
}

type definition struct {
	Manifest   json.RawMessage `json:"manifest"`
	ProviderID string          `json:"providerId"`
}
type command struct {
	ID         string                     `json:"id"`
	Op         string                     `json:"op"`
	Definition definition                 `json:"providerDefinition"`
	Request    protocol.GenerationRequest `json:"request"`
	BaseURL    string                     `json:"baseUrl"`
	Model      string                     `json:"model"`
	TaskID     string                     `json:"taskId"`
	Metadata   map[string]any             `json:"metadata"`
	Media      protocol.MediaReference    `json:"media"`
	Agent      map[string]any             `json:"agent"`
	Raw        json.RawMessage            `json:"raw"`
	RawBase64  string                     `json:"rawBase64"`
}

func adapter(d definition) (protocol.Adapter, error) {
	if len(d.Manifest) == 0 || string(d.Manifest) == "null" {
		if a, ok := protocol.Builtins().Resolve(d.ProviderID); ok {
			return a, nil
		}
		return nil, fmt.Errorf("provider %q is not installed", d.ProviderID)
	}
	values, err := protocol.LoadInstalledProviders(d.Manifest, protocol.Builtins().Resolve)
	if err != nil {
		return nil, err
	}
	for _, a := range values {
		if d.ProviderID == "" && len(values) == 1 || a.Metadata().ID == d.ProviderID {
			return a, nil
		}
	}
	return nil, fmt.Errorf("select an explicit providerId from this manifest")
}
func info(a protocol.Adapter) map[string]any {
	m := a.Metadata()
	value := map[string]any{"metadata": m, "executable": m.Enabled && m.UnavailableReason == "", "reason": m.UnavailableReason, "requiresPublicMediaUrls": m.RequiresPublicMediaURLs, "detachedPolling": m.DetachedPolling, "idempotentCreate": m.IdempotentCreate, "uploadKinds": []string{}, "agentAvailable": false, "resultAvailable": false, "cancelAvailable": m.Cancel != ""}
	if v, ok := a.(protocol.MediaUploadAdapter); ok {
		value["uploadKinds"] = v.UploadKinds()
	}
	if v, ok := a.(protocol.AgentCapability); ok {
		value["agentAvailable"] = v.AgentAvailable()
	} else {
		_, ok = a.(protocol.AgentAdapter)
		value["agentAvailable"] = ok
	}
	if v, ok := a.(protocol.ResultCapability); ok {
		value["resultAvailable"] = v.ResultAvailable()
	}
	return value
}
func execute(c command) (any, error) {
	if c.Op == "catalog" {
		items := []any{}
		for _, m := range protocol.Builtins().List("", "", true) {
			a, _ := protocol.Builtins().Get(m.ID)
			items = append(items, info(a))
		}
		return items, nil
	}
	a, err := adapter(c.Definition)
	if err != nil {
		return nil, err
	}
	ctx := context.Background()
	rc := protocol.RequestContext{BaseURL: c.BaseURL, Request: c.Request}
	pc := protocol.PollContext{BaseURL: c.BaseURL, Model: c.Model, TaskID: c.TaskID, Request: c.Request, Metadata: c.Metadata}
	raw := []byte(c.Raw)
	if c.RawBase64 != "" {
		raw, err = base64.StdEncoding.DecodeString(c.RawBase64)
		if err != nil {
			return nil, fmt.Errorf("invalid raw response encoding")
		}
	} else if len(raw) > 0 && raw[0] == '"' {
		var s string
		if json.Unmarshal(raw, &s) == nil {
			raw = []byte(s)
		}
	}
	switch c.Op {
	case "compile", "load":
		return info(a), nil
	case "buildCreate":
		return a.BuildCreate(ctx, rc)
	case "parseCreate":
		var result protocol.CreateResult
		if aware, ok := a.(protocol.RequestAwareCreateParser); ok {
			result, err = aware.ParseCreateWithRequest(ctx, c.Request, raw)
		} else {
			result, err = a.ParseCreate(ctx, raw)
		}
		if result.Result != nil {
			result.Result.Reasoning = ""
		}
		return withProgress(c, result, raw), err
	case "buildPoll":
		return a.BuildPoll(ctx, pc)
	case "parsePoll":
		result, err := a.ParsePoll(ctx, pc, raw)
		if result.Result != nil {
			result.Result.Reasoning = ""
		}
		return withProgress(c, result, raw), err
	case "buildCancel":
		return a.BuildCancel(ctx, pc)
	case "buildResult":
		if v, ok := a.(protocol.ResultAdapter); ok {
			return v.BuildResult(ctx, pc)
		}
		return nil, fmt.Errorf("provider has no binary-result operation")
	case "buildUpload":
		if v, ok := a.(protocol.MediaUploadAdapter); ok {
			return v.BuildUpload(ctx, rc, c.Media)
		}
		return nil, fmt.Errorf("provider has no upload operation")
	case "parseUpload":
		if v, ok := a.(protocol.MediaUploadAdapter); ok {
			id, err := v.ParseUpload(ctx, raw)
			return map[string]any{"id": id}, err
		}
		return nil, fmt.Errorf("provider has no upload operation")
	case "buildAgent":
		if v, ok := a.(protocol.AgentAdapter); ok {
			return v.BuildAgent(ctx, protocol.AgentRequestContext{BaseURL: c.BaseURL, Model: c.Model, Request: c.Agent})
		}
		return nil, fmt.Errorf("provider has no agent operation")
	case "parseAgent":
		if v, ok := a.(protocol.AgentAdapter); ok {
			result, err := v.ParseAgent(ctx, raw)
			return map[string]any{"text": result.Text, "toolCalls": result.ToolCalls}, err
		}
		return nil, fmt.Errorf("provider has no agent operation")
	}
	return nil, fmt.Errorf("unknown bridge operation %q", c.Op)
}
func main() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 256*1024*1024)
	writer := bufio.NewWriter(os.Stdout)
	for scanner.Scan() {
		var c command
		response := map[string]any{"id": ""}
		if err := json.Unmarshal(scanner.Bytes(), &c); err != nil {
			// Unmarshal may reject a nested typed field after successfully reading
			// the envelope ID. Never turn that request's error into an orphan reply.
			response["id"] = c.ID
			response["error"] = "invalid bridge JSON: " + err.Error()
		} else {
			response["id"] = c.ID
			func() {
				defer func() {
					if recover() != nil {
						response["error"] = "provider interpreter failed safely"
					}
				}()
				value, err := execute(c)
				if err != nil {
					response["error"] = strings.TrimSpace(err.Error())
				} else {
					response["result"] = value
				}
			}()
		}
		encoded, err := json.Marshal(response)
		if err != nil {
			encoded = []byte(`{"id":"","error":"unable to encode bridge result"}`)
		}
		writer.Write(encoded)
		writer.WriteByte('\n')
		writer.Flush()
	}
}
