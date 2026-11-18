package protocol

// EvaluateResponseExpression exposes the original evaluator to the stdio host
// for optional response metadata. It adds no expression operators or IO.
func EvaluateResponseExpression(expression any, request GenerationRequest, taskID string, body []byte) (any, error) {
	payload, err := decodeObject(body)
	if err != nil {
		return nil, err
	}
	return evaluateManifestValue(expression, map[string]any{"response": payload, "request": manifestRequestValues(request), "taskId": taskID})
}
