export type Connection = {
  id: string;
  name: string;
  headline: string;
  company: string;
  location: string;
  tags: string[];
};

export const MOCK_CONNECTIONS: Connection[] = [
  { id: "1", name: "Priya Shah", headline: "Sr. Supply Chain Manager", company: "Flipkart", location: "Bangalore", tags: ["supply chain", "logistics", "ops"] },
  { id: "2", name: "Arjun Mehta", headline: "Logistics Lead", company: "Delhivery", location: "Gurgaon", tags: ["supply chain", "last-mile", "logistics"] },
  { id: "3", name: "Neha Verma", headline: "VP Operations & Supply Chain", company: "Zomato", location: "Delhi", tags: ["supply chain", "operations"] },
  { id: "4", name: "Rohan Iyer", headline: "Procurement Manager", company: "Tata Steel", location: "Mumbai", tags: ["procurement", "supply chain"] },
  { id: "5", name: "Sara Khan", headline: "Founder & CEO", company: "FreshCart", location: "Pune", tags: ["founder", "d2c", "supply chain"] },
  { id: "6", name: "Vikram Reddy", headline: "Engineering Manager", company: "Razorpay", location: "Bangalore", tags: ["engineering", "fintech"] },
  { id: "7", name: "Anita Desai", headline: "Product Designer", company: "Swiggy", location: "Bangalore", tags: ["design", "product"] },
  { id: "8", name: "Karan Malhotra", headline: "Growth Marketer", company: "CRED", location: "Bangalore", tags: ["growth", "marketing"] },
  { id: "9", name: "Meera Joshi", headline: "Supply Chain Analyst", company: "Amazon", location: "Hyderabad", tags: ["supply chain", "analytics"] },
  { id: "10", name: "Aditya Nair", headline: "Head of Logistics", company: "Blinkit", location: "Gurgaon", tags: ["logistics", "supply chain", "q-commerce"] },
];