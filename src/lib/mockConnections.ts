export type Connection = {
  id: string;
  name: string;
  headline: string;
  company: string;
  location: string;
  tags: string[];
  email?: string;
  mutualConnections?: number;
  connectedOn?: string;
};

export const MOCK_CONNECTIONS: Connection[] = [
  {
    id: "priya-shah",
    name: "Priya Shah",
    headline: "Supply Chain Product Lead at Flipkart",
    company: "Flipkart",
    location: "Bengaluru, India",
    tags: ["supply chain", "product", "logistics", "commerce"],
    email: "priya.shah@example.com",
    mutualConnections: 18,
  },
  {
    id: "rohan-malhotra",
    name: "Rohan Malhotra",
    headline: "Senior Manager, Supply Chain Strategy at McKinsey",
    company: "McKinsey",
    location: "Mumbai, India",
    tags: ["supply chain", "strategy", "operations", "consulting"],
    email: "rohan.malhotra@example.com",
    mutualConnections: 11,
  },
  {
    id: "tanvi-iyer",
    name: "Tanvi Iyer",
    headline: "Procurement Operations Head at Zomato",
    company: "Zomato",
    location: "Gurugram, India",
    tags: ["procurement", "operations", "supply chain", "foodtech"],
    email: "tanvi.iyer@example.com",
    mutualConnections: 9,
  },
  {
    id: "vikram-reddy",
    name: "Vikram Reddy",
    headline: "Backend Engineering Manager at Razorpay",
    company: "Razorpay",
    location: "Bengaluru, India",
    tags: ["engineering", "backend", "fintech", "leadership"],
    email: "vikram.reddy@example.com",
    mutualConnections: 15,
  },
  {
    id: "kavya-nair",
    name: "Kavya Nair",
    headline: "Logistics Analytics Lead at BigBasket",
    company: "BigBasket",
    location: "Bengaluru, India",
    tags: ["logistics", "analytics", "supply chain", "data"],
    email: "kavya.nair@example.com",
    mutualConnections: 7,
  },
  {
    id: "arjun-mehta",
    name: "Arjun Mehta",
    headline: "Founder at OpsPilot AI",
    company: "OpsPilot AI",
    location: "Pune, India",
    tags: ["founder", "ai", "operations", "automation"],
    email: "arjun.mehta@example.com",
    mutualConnections: 6,
  },
];

export const MOCK_INBOX_MESSAGES = [];

export const MOCK_CONNECTION_REQUESTS = [];
