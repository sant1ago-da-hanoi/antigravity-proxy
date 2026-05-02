import { OAUTH_CONFIG, getImpersonationHeaders } from "../utils/headers";
import { type GoogleTokenResponse } from "./types";

export function generateAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: OAUTH_CONFIG.clientId,
    redirect_uri: OAUTH_CONFIG.redirectUri,
    response_type: "code",
    scope: OAUTH_CONFIG.scopes.join(" "),
    access_type: "offline",
    prompt: "consent", 
    // Static challenge to match repo analysis
    code_challenge: "cFH3lPzU2FhJjQhHlGqKqQhHlGqKqQhHlGqKqQhHlGq", 
    code_challenge_method: "plain"
  });
  return `${OAUTH_CONFIG.authUri}?${params.toString()}`;
}

export async function exchangeCode(code: string): Promise<GoogleTokenResponse> {
  const params = new URLSearchParams({
    client_id: OAUTH_CONFIG.clientId,
    client_secret: OAUTH_CONFIG.clientSecret, // REQUIRED for this Client ID
    redirect_uri: OAUTH_CONFIG.redirectUri,
    grant_type: "authorization_code",
    code: code,
    code_verifier: "cFH3lPzU2FhJjQhHlGqKqQhHlGqKqQhHlGqKqQhHlGq" 
  });

  const res = await fetch(OAUTH_CONFIG.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params // Bun's fetch handles URLSearchParams body correctly
  });

  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  return await res.json() as GoogleTokenResponse;
}

export async function refreshAccessToken(refreshToken: string): Promise<GoogleTokenResponse> {
  const params = new URLSearchParams({
    client_id: OAUTH_CONFIG.clientId,
    client_secret: OAUTH_CONFIG.clientSecret, // REQUIRED for this Client ID
    grant_type: "refresh_token",
    refresh_token: refreshToken
  });

  const res = await fetch(OAUTH_CONFIG.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });

  if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
  return await res.json() as GoogleTokenResponse;
}

export async function getProjectId(accessToken: string): Promise<string> {
  const endpoints = [
    "https://cloudcode-pa.googleapis.com",
    "https://daily-cloudcode-pa.googleapis.com"
  ];
  
  // Use numeric enum values as expected by Cloud Code API
  // ideType: 9 = ANTIGRAVITY, platform: 2 = DARWIN_ARM64, pluginType: 2 = GEMINI
  const metadata = { ideType: 9, platform: 2, pluginType: 2 };

  // Step 1: Try loadCodeAssist to discover existing project
  for (const endpoint of endpoints) {
    try {
      const res = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: getImpersonationHeaders(accessToken),
        body: JSON.stringify({ metadata })
      });

      const body = await res.text();
      if (res.ok) {
        const data = JSON.parse(body);
        const project = data?.cloudaicompanionProject;
        const projectId = typeof project === "string" ? project : project?.id;
        
        if (projectId) {
          console.log(`[OAuth] Discovered Project ID from ${endpoint}: ${projectId}`);
          return projectId;
        }

        // No project yet — try onboarding with default tier
        const allowedTiers = data?.allowedTiers;
        if (Array.isArray(allowedTiers) && allowedTiers.length > 0) {
          const defaultTier = allowedTiers.find((t: any) => t.isDefault) || allowedTiers[0];
          const tierId = defaultTier?.id;
          if (tierId) {
            console.log(`[OAuth] No project found, onboarding with tier: ${tierId}`);
            const onboardedProject = await onboardUser(accessToken, tierId, metadata);
            if (onboardedProject) return onboardedProject;
          }
        }
        console.warn(`[OAuth] loadCodeAssist OK but no projectId (${endpoint}):`, body.substring(0, 500));
      } else {
        console.warn(`[OAuth] loadCodeAssist failed (${endpoint}): ${res.status} ${body.substring(0, 200)}`);
      }
    } catch (e) {
      console.warn(`[OAuth] Failed loadCodeAssist at ${endpoint}:`, e);
    }
  }

  return "";
}

async function onboardUser(
  accessToken: string, 
  tierId: string, 
  metadata: any,
  maxAttempts = 10, 
  delayMs = 5000
): Promise<string> {
  const endpoints = [
    "https://daily-cloudcode-pa.googleapis.com",
    "https://cloudcode-pa.googleapis.com"
  ];

  for (const endpoint of endpoints) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const res = await fetch(`${endpoint}/v1internal:onboardUser`, {
          method: "POST",
          headers: getImpersonationHeaders(accessToken),
          body: JSON.stringify({ tierId, metadata })
        });

        if (!res.ok) {
          const errorText = await res.text();
          console.warn(`[OAuth] onboardUser failed at ${endpoint}: ${res.status} - ${errorText.substring(0, 200)}`);
          break; // Try next endpoint
        }

        const data = await res.json() as any;
        console.log(`[OAuth] onboardUser response (attempt ${attempt + 1}):`, JSON.stringify(data).substring(0, 500));

        const managedProjectId = data.response?.cloudaicompanionProject?.id;
        if (data.done && managedProjectId) {
          console.log(`[OAuth] Onboarded successfully, project: ${managedProjectId}`);
          return managedProjectId;
        }

        // Not done yet, wait and retry
        if (attempt < maxAttempts - 1) {
          console.log(`[OAuth] onboardUser not complete, waiting ${delayMs}ms...`);
          await new Promise(r => setTimeout(r, delayMs));
        }
      } catch (error) {
        console.warn(`[OAuth] onboardUser error at ${endpoint}:`, error);
        break;
      }
    }
  }

  console.warn(`[OAuth] All onboarding attempts failed for tier: ${tierId}`);
  return "";
}

export async function getUserEmail(accessToken: string): Promise<string> {
   const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` }
   });
   if (!res.ok) throw new Error("Failed to fetch user info");
   const data = await res.json() as any;
   return data.email as string;
}
