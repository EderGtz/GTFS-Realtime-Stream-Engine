import axios, { type AxiosRequestConfig } from 'axios';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Makes an HTTP GET request using Axios with an exponential backoff strategy.
 */
export async function fetchWithBackoff(
    url: string, 
    options: AxiosRequestConfig, 
    maxAttempts: number = 3, 
    baseWaitMs: number = 1000
) {
    let currentAttempt = 0;

    while (currentAttempt < maxAttempts) {
        try {
            const response = await axios.get(url, options);
            return response;
        } catch (error: any) {
            currentAttempt++;
            
            // If we've hit our limit, throw the error up the chain
            if (currentAttempt >= maxAttempts) {
                throw new Error(`Failed after ${maxAttempts} attempts. Last error: ${error.message}`);
            }

            // Calculate backoff: baseWait * (2 ^ attempt) + random jitter (0-500ms)
            const jitter = Math.floor(Math.random() * 500);
            const waitTime = (baseWaitMs * Math.pow(2, currentAttempt)) + jitter;
            
            console.warn(`[HTTP Warn] Request failed. Retrying in ${waitTime}ms (Attempt ${currentAttempt + 1} of ${maxAttempts})`);
            
            await delay(waitTime);
        }
    }
}