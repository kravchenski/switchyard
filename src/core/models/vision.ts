const VISION = /vision|[-_/.]vl(?:[-_.]|$)|omni|multimodal|gemini|gemma-?[34]|llama-?4|pixtral|llava|gpt-4o|gpt-4\.1|gpt-5|kimi-k2\.[56]|kimi-k3|glm-?\d(?:\.\d)?v|mistral-(?:small|medium)-3/i;

export function looksVisionCapable(model: string) {
  return VISION.test(model);
}
