package crewrouter

import (
	"context"
	"encoding/base64"
	"net/http"
	"os"
	"time"
)

// Options configures a Client.
type Options struct {
	BaseURL            string
	APIKey             string
	OAuthToken         string
	AuthStyle          string       // "bearer" (default) or "x-api-key"
	HTTPClient         *http.Client // Custom clients retain their own redirect policy.
	Timeout            time.Duration
	StreamIdleTimeout  time.Duration
	MaxRetries         int
	RetryNonIdempotent bool
	Headers            map[string]string
	SignatureMode      string
	UserAgent          string
	Sleep              func(context.Context, time.Duration) error
}

// Client is the CrewRouter Go client.
type Client struct {
	BaseURL            string
	HTTPClient         *http.Client
	Timeout            time.Duration
	StreamIdleTimeout  time.Duration
	MaxRetries         int
	RetryNonIdempotent bool
	Operations         map[string]Operation

	apiKey        string
	oauthToken    string
	authStyle     string
	signatureMode string
	userAgent     string
	headers       map[string]string
	sleep         func(context.Context, time.Duration) error

	Gateway   *GatewayResource
	Keys      *KeysResource
	Usage     *UsageResource
	Balance   *BalanceResource
	Models    *ModelsResource
	Providers *ProvidersResource
	Admin     *AdminResource
}

// New creates a CrewRouter client.
func New(options Options) (*Client, error) {
	baseURL := options.BaseURL
	if baseURL == "" {
		baseURL = os.Getenv("CREWROUTER_BASE_URL")
	}
	if baseURL == "" {
		return nil, &ConnectionError{Err: errString("base URL is required (or set CREWROUTER_BASE_URL)")}
	}
	apiKey := options.APIKey
	if apiKey == "" {
		apiKey = os.Getenv("CREWROUTER_API_KEY")
	}
	authStyle := options.AuthStyle
	if authStyle == "" {
		authStyle = "bearer"
	}
	userAgent := options.UserAgent
	if userAgent == "" {
		userAgent = defaultUserAgent
	}
	streamIdle := options.StreamIdleTimeout
	if streamIdle == 0 {
		streamIdle = defaultStreamIdleTimeout
	}
	httpClient := options.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{CheckRedirect: defaultCheckRedirect}
	}

	client := &Client{
		BaseURL:            baseURL,
		HTTPClient:         httpClient,
		Timeout:            options.Timeout,
		StreamIdleTimeout:  streamIdle,
		MaxRetries:         options.MaxRetries,
		RetryNonIdempotent: options.RetryNonIdempotent,
		Operations:         Operations,
		apiKey:             apiKey,
		oauthToken:         options.OAuthToken,
		authStyle:          authStyle,
		signatureMode:      options.SignatureMode,
		userAgent:          userAgent,
		headers:            options.Headers,
		sleep:              options.Sleep,
	}
	if client.sleep == nil {
		client.sleep = client.defaultSleep
	}
	client.Gateway = newGatewayResource(client)
	client.Keys = &KeysResource{client: client}
	client.Usage = &UsageResource{client: client}
	client.Balance = &BalanceResource{client: client}
	client.Models = &ModelsResource{client: client}
	client.Providers = &ProvidersResource{client: client}
	client.Admin = newAdminResource(client)
	return client, nil
}

type errString string

func (e errString) Error() string { return string(e) }

func firstCallOptions(opts []CallOptions) CallOptions {
	if len(opts) > 0 {
		return opts[0]
	}
	return CallOptions{}
}

func firstStreamOptions(opts []StreamOptions) StreamOptions {
	if len(opts) > 0 {
		return opts[0]
	}
	return StreamOptions{}
}

func withBody(opts []CallOptions, body any) CallOptions {
	options := firstCallOptions(opts)
	options.Body = body
	return options
}

func withPath(opts []CallOptions, name string, value any) CallOptions {
	options := firstCallOptions(opts)
	params := map[string]any{}
	for key, item := range options.PathParams {
		params[key] = item
	}
	params[name] = value
	options.PathParams = params
	return options
}

func decodeBase64(value string) (string, error) {
	data, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// GatewayResource groups the gateway endpoints.
type GatewayResource struct {
	Chat      *ChatResource
	Messages  *MessagesResource
	Responses *ResponsesResource
	Models    *GatewayModelsResource
}

// ChatResource groups chat completions.
type ChatResource struct{ Completions *ChatCompletionsResource }

// ChatCompletionsResource calls /v1/chat/completions.
type ChatCompletionsResource struct{ client *Client }

func (r *ChatCompletionsResource) Create(ctx context.Context, body any, opts ...CallOptions) (*Response, error) {
	return r.client.Call(ctx, "gateway.chat.completions.create", withBody(opts, body))
}

func (r *ChatCompletionsResource) Stream(ctx context.Context, body any, opts ...StreamOptions) (*Stream, error) {
	return r.client.Stream(ctx, http.MethodPost, "/v1/chat/completions", body, firstStreamOptions(opts))
}

// MessagesResource calls /v1/messages.
type MessagesResource struct{ client *Client }

func (r *MessagesResource) Create(ctx context.Context, body any, opts ...CallOptions) (*Response, error) {
	return r.client.Call(ctx, "gateway.messages.create", withBody(opts, body))
}

func (r *MessagesResource) Stream(ctx context.Context, body any, opts ...StreamOptions) (*Stream, error) {
	return r.client.Stream(ctx, http.MethodPost, "/v1/messages", body, firstStreamOptions(opts))
}

// ResponsesResource calls /v1/responses.
type ResponsesResource struct{ client *Client }

func (r *ResponsesResource) Create(ctx context.Context, body any, opts ...CallOptions) (*Response, error) {
	return r.client.Call(ctx, "gateway.responses.create", withBody(opts, body))
}

func (r *ResponsesResource) Stream(ctx context.Context, body any, opts ...StreamOptions) (*Stream, error) {
	return r.client.Stream(ctx, http.MethodPost, "/v1/responses", body, firstStreamOptions(opts))
}

// GatewayModelsResource calls /v1/models.
type GatewayModelsResource struct{ client *Client }

func (r *GatewayModelsResource) List(ctx context.Context, opts ...CallOptions) (*Response, error) {
	return r.client.Call(ctx, "gateway.models.list", firstCallOptions(opts))
}

func newGatewayResource(client *Client) *GatewayResource {
	return &GatewayResource{
		Chat:      &ChatResource{Completions: &ChatCompletionsResource{client: client}},
		Messages:  &MessagesResource{client: client},
		Responses: &ResponsesResource{client: client},
		Models:    &GatewayModelsResource{client: client},
	}
}

// KeysResource manages API keys.
type KeysResource struct{ client *Client }

func (r *KeysResource) List(ctx context.Context, opts ...CallOptions) (*Response, error) {
	return r.client.Call(ctx, "user.apiKeys.list", firstCallOptions(opts))
}

func (r *KeysResource) Create(ctx context.Context, body any, opts ...CallOptions) (*Response, error) {
	return r.client.Call(ctx, "user.apiKeys.create", withBody(opts, body))
}

func (r *KeysResource) Update(ctx context.Context, id any, body any, opts ...CallOptions) (*Response, error) {
	return r.client.Call(ctx, "user.apiKeys.byId.update", withBody([]CallOptions{withPath(opts, "id", id)}, body))
}

func (r *KeysResource) Delete(ctx context.Context, id any, opts ...CallOptions) (*Response, error) {
	return r.client.Call(ctx, "user.apiKeys.byId.delete", withPath(opts, "id", id))
}

func (r *KeysResource) GetModels(ctx context.Context, id any, opts ...CallOptions) (*Response, error) {
	return r.client.Call(ctx, "user.apiKeys.byId.models.list", withPath(opts, "id", id))
}

func (r *KeysResource) SetModels(ctx context.Context, id any, body any, opts ...CallOptions) (*Response, error) {
	return r.client.Call(ctx, "user.apiKeys.byId.models.update", withBody([]CallOptions{withPath(opts, "id", id)}, body))
}

func (r *KeysResource) GetConfig(ctx context.Context, id any, opts ...CallOptions) (*Response, error) {
	return r.client.Call(ctx, "user.apiKeys.byId.config.list", withPath(opts, "id", id))
}

// UsageResource reads usage statistics.
type UsageResource struct{ client *Client }

func (r *UsageResource) Get(ctx context.Context, query map[string]any, opts ...CallOptions) (*Response, error) {
	options := firstCallOptions(opts)
	options.Query = query
	return r.client.Call(ctx, "user.usage.list", options)
}

// BalanceResource reads the balance.
type BalanceResource struct{ client *Client }

func (r *BalanceResource) Get(ctx context.Context, opts ...CallOptions) (*Response, error) {
	return r.client.Call(ctx, "user.balance.list", firstCallOptions(opts))
}

// ModelsResource lists the models visible to the user.
type ModelsResource struct{ client *Client }

func (r *ModelsResource) List(ctx context.Context, opts ...CallOptions) (*Response, error) {
	return r.client.Call(ctx, "user.models.list", firstCallOptions(opts))
}

// ProvidersResource lists providers.
type ProvidersResource struct{ client *Client }

func (r *ProvidersResource) List(ctx context.Context, opts ...CallOptions) (*Response, error) {
	return r.client.Call(ctx, "user.providers.list", firstCallOptions(opts))
}

// AdminResource groups admin operations.
type AdminResource struct {
	Users     *AdminUsersResource
	Models    *AdminModelsResource
	Providers *AdminProvidersResource
	Teams     *AdminTeamsResource
}

type AdminUsersResource struct{ client *Client }

func (r *AdminUsersResource) List(ctx context.Context, opts ...CallOptions) (*Response, error) {
	return r.client.Call(ctx, "admin.users.list", firstCallOptions(opts))
}

type AdminModelsResource struct{ client *Client }

func (r *AdminModelsResource) List(ctx context.Context, opts ...CallOptions) (*Response, error) {
	return r.client.Call(ctx, "admin.models.list", firstCallOptions(opts))
}

type AdminProvidersResource struct{ client *Client }

func (r *AdminProvidersResource) List(ctx context.Context, opts ...CallOptions) (*Response, error) {
	return r.client.Call(ctx, "admin.providers.list", firstCallOptions(opts))
}

func (r *AdminProvidersResource) Get(ctx context.Context, id any, opts ...CallOptions) (*Response, error) {
	return r.client.Call(ctx, "admin.providers.byId.get", withPath(opts, "id", id))
}

func (r *AdminProvidersResource) RefreshKey(ctx context.Context, id any, opts ...CallOptions) (*Response, error) {
	return r.client.Call(ctx, "admin.providers.byId.refreshKey", withPath(opts, "id", id))
}

type AdminTeamsResource struct{ client *Client }

func (r *AdminTeamsResource) List(ctx context.Context, opts ...CallOptions) (*Response, error) {
	return r.client.Call(ctx, "admin.teams.list", firstCallOptions(opts))
}

func newAdminResource(client *Client) *AdminResource {
	return &AdminResource{
		Users:     &AdminUsersResource{client: client},
		Models:    &AdminModelsResource{client: client},
		Providers: &AdminProvidersResource{client: client},
		Teams:     &AdminTeamsResource{client: client},
	}
}
