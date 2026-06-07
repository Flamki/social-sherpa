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
};
