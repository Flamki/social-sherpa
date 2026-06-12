export type Connection = {
  id: string;
  name: string;
  headline: string;
  company: string;
  location: string;
  tags: string[];
  profileUrl?: string;
  email?: string;
  mutualConnections?: number;
  connectedOn?: string;
  /** Epoch ms of when the connection was made, when LinkedIn includes it on the record. */
  connectedAt?: number;
};
