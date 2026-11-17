#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface InProcess : NSObject
- (void)request:(NSString *)operation arguments:(NSDictionary<NSString *, id> *)arguments completion:(void (NS_SWIFT_UI_ACTOR ^)(NSDictionary<NSString *, id> *))completion;
@end

NS_ASSUME_NONNULL_END
