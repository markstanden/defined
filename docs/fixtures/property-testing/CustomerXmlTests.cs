using Shouldly;
using Xunit;

public sealed class CustomerXmlTests
{
    // Promoted from the failure: a mixed-case name must survive the round trip.
    [Fact]
    public void RenderThenParse_WithMixedCaseName_RestoresOriginal()
    {
        // Arrange
        Customer original = new Customer(1, "Alan");

        // Act
        Customer reparsed = CustomerXml.Parse(CustomerXml.Render(original));

        // Assert
        reparsed.ShouldBe(original);
    }
}
