package protocol

import (
	"context"
	"strings"
	"testing"
)

func Test888SeedanceMaxLocalPreservesRealReferenceURLsAndNativeFields(t *testing.T) {
	adapter := officialPackageAdapter(t, "888-seedance-max-local.yingce-plugin", "888-seedance-max-local")
	request := GenerationRequest{Model: "seedance2.5-301010-max", Prompt: "保持参考图人物一致。", Operation: "reference_to_video", Duration: 13, Resolution: "720P", AspectRatio: "16:9", GenerateAudio: true, Images: []MediaReference{{URL: "https://assets.example.test/second.png", Order: 2}, {URL: "https://assets.example.test/first.png", Order: 1}}, Videos: []MediaReference{{URL: "https://assets.example.test/motion.mp4", Order: 1}}, Audios: []MediaReference{{URL: "https://assets.example.test/voice.mp3", Order: 1}}}
	spec, err := adapter.BuildCreate(context.Background(), RequestContext{Request: request})
	if err != nil {
		t.Fatal(err)
	}
	body := manifestTestBody(t, spec)
	if spec.Method != "POST" || spec.Path != "/v1/videos" || !spec.OriginPath || spec.Auth.Type != "bearer" {
		t.Fatalf("native request contract = %#v", spec)
	}
	if body["duration"] != float64(13) || body["ratio"] != "16:9" || body["resolution"] != "720p" || body["prompt"] != request.Prompt {
		t.Fatalf("native video fields = %#v", body)
	}
	images, ok := body["images"].([]any)
	if !ok || len(images) != 2 || images[0] != "https://assets.example.test/first.png" || images[1] != "https://assets.example.test/second.png" {
		t.Fatalf("reference order = %#v", body["images"])
	}
	for _, field := range []string{"image_urls", "video_urls", "audio_urls", "seconds", "aspect_ratio", "generate_audio"} {
		if _, exists := body[field]; exists {
			t.Fatalf("unexpected other-protocol field %s", field)
		}
	}
	if len(body["videos"].([]any)) != 1 || len(body["audios"].([]any)) != 1 {
		t.Fatalf("reference media lost: %#v", body)
	}
}

func Test888SeedanceMaxLocalRejectsWrongModelLimitsAndKeyframeSemantics(t *testing.T) {
	adapter := officialPackageAdapter(t, "888-seedance-max-local.yingce-plugin", "888-seedance-max-local")
	base := GenerationRequest{Model: "seedance2.5-301010-max", Prompt: "测试", Duration: 6, AspectRatio: "16:9", Resolution: "720p", GenerateAudio: true}
	tests := []struct {
		name   string
		change func(*GenerationRequest)
	}{
		{"different model", func(r *GenerationRequest) { r.Model = "seedance2.5-301010-wool" }},
		{"short duration", func(r *GenerationRequest) { r.Duration = 3 }},
		{"long duration", func(r *GenerationRequest) { r.Duration = 31 }},
		{"resolution", func(r *GenerationRequest) { r.Resolution = "1080p" }},
		{"empty prompt", func(r *GenerationRequest) { r.Prompt = " " }},
		{"image count", func(r *GenerationRequest) { r.Images = make([]MediaReference, 31) }},
		{"video count", func(r *GenerationRequest) { r.Videos = make([]MediaReference, 11) }},
		{"audio count", func(r *GenerationRequest) { r.Audios = make([]MediaReference, 11) }},
		{"first frame role", func(r *GenerationRequest) {
			r.Images = []MediaReference{{URL: "https://assets.example.test/start.png", Role: "first_frame"}}
		}},
		{"keyframe operation", func(r *GenerationRequest) { r.Operation = "image_to_video" }},
		{"disable native audio", func(r *GenerationRequest) { r.GenerateAudio = false }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			request := base
			tc.change(&request)
			if _, err := adapter.BuildCreate(context.Background(), RequestContext{Request: request}); err == nil {
				t.Fatal("invalid input was silently accepted")
			}
		})
	}
}

func Test888SeedanceMaxLocalPollAndResultKeepTheOriginalTask(t *testing.T) {
	adapter := officialPackageAdapter(t, "888-seedance-max-local.yingce-plugin", "888-seedance-max-local")
	accepted, err := adapter.ParseCreate(context.Background(), []byte(`{"id":"task_888_native_1","status":"queued"}`))
	if err != nil || accepted.TaskID != "task_888_native_1" || accepted.Status != StatusPending {
		t.Fatalf("create = %#v, %v", accepted, err)
	}
	ctx := PollContext{Model: "seedance2.5-301010-max", TaskID: accepted.TaskID}
	poll, err := adapter.BuildPoll(context.Background(), ctx)
	if err != nil || poll.Path != "/v1/videos/task_888_native_1" || poll.Method != "GET" {
		t.Fatalf("poll = %#v, %v", poll, err)
	}
	completed, err := adapter.ParsePoll(context.Background(), ctx, []byte(`{"id":"task_888_native_1","status":"completed","url":"https://cdn.example.test/result.mp4"}`))
	if err != nil || completed.Status != StatusSucceeded || completed.Result == nil || len(completed.Result.Videos) != 1 || completed.Result.Videos[0].URL != "https://cdn.example.test/result.mp4" {
		t.Fatalf("completed = %#v, %v", completed, err)
	}
	failed, err := adapter.ParsePoll(context.Background(), ctx, []byte(`{"id":"task_888_native_1","status":"failed","error":{"message":"input rejected"}}`))
	if err != nil || failed.Status != StatusFailed || !strings.Contains(failed.Message, "input rejected") {
		t.Fatalf("failed = %#v, %v", failed, err)
	}
	result, err := adapter.(ResultAdapter).BuildResult(context.Background(), ctx)
	if err != nil || result.Path != "/v1/videos/task_888_native_1/content" || result.Auth.Type != "bearer" || result.Headers["Accept"] != "video/mp4" {
		t.Fatalf("result = %#v, %v", result, err)
	}
}

func Test888SeedanceC5LocalKeepsItsOwnLimitsAndAllDocumentedMedia(t *testing.T) {
	adapter := officialPackageAdapter(t, "888-seedance-max-local.yingce-plugin", "888-seedance-c5-local")
	request := GenerationRequest{Model: "seedance2.0-933-c5-fast", Prompt: "保持所有参考素材一致", Operation: "reference_to_video", Duration: 15, AspectRatio: "9:16", Resolution: "720p", GenerateAudio: true}
	for i := 0; i < 9; i++ {
		request.Images = append(request.Images, MediaReference{URL: "https://assets.example.test/ref.png", Order: i + 1})
	}
	for i := 0; i < 3; i++ {
		request.Videos = append(request.Videos, MediaReference{URL: "https://assets.example.test/ref.mp4", Order: i + 1})
		request.Audios = append(request.Audios, MediaReference{URL: "https://assets.example.test/ref.mp3", Order: i + 1})
	}
	spec, err := adapter.BuildCreate(context.Background(), RequestContext{Request: request})
	if err != nil {
		t.Fatal(err)
	}
	body := manifestTestBody(t, spec)
	if spec.Path != "/v1/videos" || body["model"] != request.Model || body["duration"] != float64(15) || body["ratio"] != "9:16" || len(body["images"].([]any)) != 9 || len(body["videos"].([]any)) != 3 || len(body["audios"].([]any)) != 3 {
		t.Fatalf("C5 documented input was changed or dropped: %#v", body)
	}
	// C5's row documents per-kind limits; do not inherit C4's total-12 rule.
	for _, change := range []func(*GenerationRequest){
		func(r *GenerationRequest) { r.Model = "seedance2.5-301010-max" },
		func(r *GenerationRequest) { r.Duration = 16 },
		func(r *GenerationRequest) {
			r.Images = append(r.Images, MediaReference{URL: "https://assets.example.test/tenth.png"})
		},
		func(r *GenerationRequest) {
			r.Videos = append(r.Videos, MediaReference{URL: "https://assets.example.test/fourth.mp4"})
		},
		func(r *GenerationRequest) {
			r.Audios = append(r.Audios, MediaReference{URL: "https://assets.example.test/fourth.mp3"})
		},
	} {
		invalid := request
		invalid.Images = append([]MediaReference(nil), request.Images...)
		invalid.Videos = append([]MediaReference(nil), request.Videos...)
		invalid.Audios = append([]MediaReference(nil), request.Audios...)
		change(&invalid)
		if _, err := adapter.BuildCreate(context.Background(), RequestContext{Request: invalid}); err == nil {
			t.Fatal("C5 accepted another model or limits beyond its own contract")
		}
	}
}
