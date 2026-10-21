/// <reference types="node" />

declare namespace NodeJS {
  interface ProcessEnv {
    PUBLIC_SUPABASE_URL?: string
    PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string
    BUILD_TIME?: string
    SUPABASE_URL?: string
    SUPABASE_PUBLISHABLE_KEY?: string
  }
}

declare module '*.css' {
  const value: string
  export default value
}
