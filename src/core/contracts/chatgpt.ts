/** Client-safe status only. Credentials and OAuth transaction data never enter this contract. */
export interface ChatGPTStatus {
	available: boolean;
	pending: boolean;
	activeId: string | null;
	accounts: { id: string; email: string; registration: string; connected: boolean; background: boolean; planEnabled?: boolean }[];
	error: string | null;
	catalogError?: string | null;
}
export interface ChatGPTControlBridge {
	status(): Promise<ChatGPTStatus>;
	login(id?: string): Promise<ChatGPTStatus>;
	cancel(): Promise<ChatGPTStatus>;
	select(id: string): Promise<ChatGPTStatus>;
	logout(id: string): Promise<ChatGPTStatus>;
	consent(id: string, enabled: boolean): Promise<ChatGPTStatus>;
	onChange(callback: () => void): () => void;
}
