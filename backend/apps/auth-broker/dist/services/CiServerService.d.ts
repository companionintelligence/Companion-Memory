export interface UserInfo {
    id: string;
    username: string;
    email: string;
}
export declare class CiServerService {
    private readonly httpClient;
    constructor();
    validateUserToken(token: string): Promise<UserInfo | null>;
    notifyTokenUpdate(userId: string, providerId: string, hasToken: boolean): Promise<void>;
}
